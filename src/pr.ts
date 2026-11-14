import crypto from 'node:crypto';
import path from 'node:path';
import { Octokit } from '@octokit/rest';
import type { Sandbox } from '@vercel/sandbox';
import type { CheckResult } from './checks.js';
import type { FactoryRequest } from './request.js';
import { exec } from './sandbox.js';

export const MAX_CHANGED_FILES = 50;
export const MAX_FILE_SIZE_BYTES = 1 * 1024 * 1024; // 1 MB
export const MAX_PR_BODY_CHARS = 59_000;
export const MAX_TASK_PREVIEW_CHARS = 500;

export interface FileClassification {
  path: string;
  type: 'added' | 'modified' | 'deleted';
}

export interface PrResult {
  url?: string;
  number?: number;
  branch?: string;
  headSha?: string;
  error?: string;
}

export interface PrBodyParams {
  task: string;
  finalSummary: string;
  baseline: Record<string, { exitCode: number; preexisting: boolean }> | null;
  rounds: Array<{
    round: number;
    checks: Record<string, { exitCode: number; passed: boolean; preexisting: boolean }>;
  }>;
  roundsUsed: number;
  selfRepairs: { count: number; checks: string[] };
  agentSteps: number;
  tokenUsage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  cpuUsageMs: number | null;
  geminiModel: string;
  changes: FileClassification[];
}

export function redactToken(text: string, token?: string): string {
  if (!token || token.trim() === '') return text;
  return text.replaceAll(token, '[REDACTED_GITHUB_PR_TOKEN]');
}

export function parseGitHubRepo(repoUrl: string): { owner: string; repo: string } {
  try {
    const url = new URL(repoUrl);
    const parts = url.pathname.replace(/^\/+|\.git$/g, '').split('/');
    if (parts.length >= 2 && parts[0] && parts[1]) {
      return { owner: parts[0], repo: parts[1] };
    }
  } catch {
    const match = repoUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?/);
    if (match && match[1] && match[2]) {
      return { owner: match[1], repo: match[2] };
    }
  }
  throw new Error(`Unable to parse GitHub owner and repository from URL: "${repoUrl}"`);
}

export function createBranchSlug(task: string): string {
  const firstLine = task.split('\n')[0] ?? '';
  const slug = firstLine
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'task';
}

export function generateRandomId(length = 6): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i]! % chars.length];
  }
  return result;
}

export function neutralizeMentionsAndRefs(text: string): string {
  return text
    .replace(/@([a-zA-Z0-9_-]+)/g, '@\u200B$1')
    .replace(/#([0-9]+)/g, '#\u200B$1');
}

export function parseGitStatusPorcelainV1Z(raw: string): FileClassification[] {
  const tokens = raw.split('\0');
  const results: FileClassification[] = [];

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (!token || token.length < 4) {
      i++;
      continue;
    }

    const x = token[0];
    const y = token[1];
    const filePath = token.slice(3);

    if (x === 'R' || y === 'R' || x === 'C' || y === 'C') {
      i++;
      const newPath = tokens[i] ?? '';
      results.push({ path: filePath, type: 'deleted' });
      if (newPath) {
        results.push({ path: newPath, type: 'added' });
      }
    } else if (x === '?' && y === '?') {
      results.push({ path: filePath, type: 'added' });
    } else if (x === 'A' || y === 'A') {
      results.push({ path: filePath, type: 'added' });
    } else if (x === 'D' || y === 'D') {
      results.push({ path: filePath, type: 'deleted' });
    } else {
      results.push({ path: filePath, type: 'modified' });
    }
    i++;
  }

  const map = new Map<string, 'added' | 'modified' | 'deleted'>();
  for (const item of results) {
    map.set(item.path, item.type);
  }

  return Array.from(map.entries()).map(([filePath, type]) => ({
    path: filePath,
    type,
  }));
}

export function validateChangeSet(
  changes: FileClassification[],
): { ok: true } | { ok: false; error: string } {
  if (changes.length === 0) {
    return { ok: false, error: 'no changes' };
  }

  if (changes.length > MAX_CHANGED_FILES) {
    return {
      ok: false,
      error: `Change set exceeds maximum limit of ${MAX_CHANGED_FILES} files (${changes.length} files changed).`,
    };
  }

  for (const change of changes) {
    const p = change.path.replace(/\\/g, '/');

    if (path.isAbsolute(p) || p.startsWith('/') || p.split('/').includes('..')) {
      return {
        ok: false,
        error: `Protected path violation: path escapes repository root ("${p}").`,
      };
    }

    const segments = p.split('/');
    if (
      segments.includes('.git') ||
      segments.includes('.github') ||
      segments.includes('node_modules')
    ) {
      return {
        ok: false,
        error: `Protected path violation: path under forbidden directory ("${p}").`,
      };
    }

    const basename = path.posix.basename(p);
    if (basename.startsWith('.env')) {
      return {
        ok: false,
        error: `Protected path violation: environment file ("${p}").`,
      };
    }
    if (basename === 'pnpm-lock.yaml') {
      return {
        ok: false,
        error: `Protected path violation: lockfile ("${p}").`,
      };
    }
    if (basename === 'package.json') {
      return {
        ok: false,
        error: `Protected path violation: package.json file ("${p}").`,
      };
    }
  }

  return { ok: true };
}

export function buildPrBody(params: PrBodyParams): string {
  // 1. Task preview (blockquote, max 500 chars, neutralized)
  let taskPreview = params.task;
  if (taskPreview.length > MAX_TASK_PREVIEW_CHARS) {
    taskPreview = `${taskPreview.slice(0, MAX_TASK_PREVIEW_CHARS)}... (truncated)`;
  }
  const neutralizedTask = neutralizeMentionsAndRefs(taskPreview)
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');

  // 2. Summary
  const summaryText = params.finalSummary.trim() || '(no summary provided)';

  // 3. Checks table
  // Collect all unique check names from baseline and rounds
  const checkNames = new Set<string>();
  if (params.baseline) {
    for (const name of Object.keys(params.baseline)) {
      checkNames.add(name);
    }
  }
  for (const r of params.rounds) {
    for (const name of Object.keys(r.checks)) {
      checkNames.add(name);
    }
  }

  const roundHeaders = params.rounds.map((r) => `Round ${r.round}`);
  const headerCols = ['Check', 'Baseline', ...roundHeaders, 'Final'];
  const headerRow = `| ${headerCols.join(' | ')} |`;
  const separatorRow = `| ${headerCols.map(() => ':---').join(' | ')} |`;

  const tableRows: string[] = [];
  for (const name of checkNames) {
    const rowCols: string[] = [name];

    // Baseline
    if (params.baseline && params.baseline[name]) {
      const b = params.baseline[name];
      rowCols.push(b.preexisting ? 'Failed (preexisting)' : 'Passed');
    } else {
      rowCols.push('Skipped');
    }

    // Rounds
    for (const r of params.rounds) {
      const c = r.checks[name];
      if (!c) {
        rowCols.push('-');
      } else if (c.preexisting) {
        rowCols.push('Failed (preexisting)');
      } else {
        rowCols.push(c.passed ? 'Passed' : 'Failed');
      }
    }

    // Final
    const lastRound = params.rounds[params.rounds.length - 1];
    const lastCheck = lastRound?.checks[name];
    if (lastCheck) {
      rowCols.push(lastCheck.passed || lastCheck.preexisting ? 'Passed' : 'Failed');
    } else {
      rowCols.push('-');
    }

    tableRows.push(`| ${rowCols.join(' | ')} |`);
  }

  const checksTable = [headerRow, separatorRow, ...tableRows].join('\n');

  // 4. Run stats
  const cpuMsText = params.cpuUsageMs !== null ? `${params.cpuUsageMs.toLocaleString()} ms` : 'unavailable';
  const statsList = [
    `- **Model**: \`${params.geminiModel}\``,
    `- **Rounds Used**: ${params.roundsUsed}`,
    `- **Self-Repairs**: ${params.selfRepairs.count}${params.selfRepairs.checks.length > 0 ? ` (${params.selfRepairs.checks.join(', ')})` : ''}`,
    `- **Agent Steps**: ${params.agentSteps}`,
    `- **Tokens**: ${params.tokenUsage.promptTokens.toLocaleString()} prompt / ${params.tokenUsage.completionTokens.toLocaleString()} completion / ${params.tokenUsage.totalTokens.toLocaleString()} total`,
    `- **CPU Duration**: ${cpuMsText}`,
  ].join('\n');

  // 5. Files changed
  const filesList = params.changes
    .map((c) => `- \`${c.path}\` (${c.type})`)
    .join('\n');

  // 6. Footer
  const footer = '---\n*Opened by software-factory. AI-generated draft. Review before merging.*';

  let body = [
    '### Task',
    neutralizedTask,
    '',
    '### Summary',
    summaryText,
    '',
    '### Verification Checks',
    checksTable,
    '',
    '### Run Stats',
    statsList,
    '',
    '### Files Changed',
    filesList,
    '',
    footer,
  ].join('\n');

  if (body.length > MAX_PR_BODY_CHARS) {
    body =
      body.slice(0, MAX_PR_BODY_CHARS) +
      '\n\n*(PR body truncated to stay within character limits)*\n\n' +
      footer;
  }

  return body;
}

export interface HandlePrOptions {
  sandbox: Sandbox;
  repoDir: string;
  request: FactoryRequest;
  dryRun?: boolean;
  token?: string;
  geminiModel: string;
  finalSummary: string;
  baseline: Record<string, { exitCode: number; preexisting: boolean }> | null;
  rounds: Array<{
    round: number;
    checks: Record<string, { exitCode: number; passed: boolean; preexisting: boolean }>;
  }>;
  roundsUsed: number;
  selfRepairs: { count: number; checks: string[] };
  agentSteps: number;
  tokenUsage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  cpuUsageMs: number | null;
  signal?: AbortSignal;
}

export async function handlePr(options: HandlePrOptions): Promise<PrResult> {
  const { sandbox, repoDir, request, dryRun, token, signal } = options;

  // Step 1: Inspect the sandbox
  console.log('\n=== Preparing Pull Request ===');
  const baseShaRes = await exec(sandbox, {
    cmd: 'git',
    args: ['rev-parse', 'HEAD'],
    cwd: repoDir,
    silent: true,
    signal,
  });
  if (baseShaRes.exitCode !== 0) {
    const err = `Failed to get base SHA from sandbox: ${baseShaRes.output}`;
    console.error(`[pr] ${err}`);
    return { error: err };
  }
  const baseSha = baseShaRes.stdout.trim();

  const statusRes = await exec(sandbox, {
    cmd: 'git',
    args: ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    cwd: repoDir,
    silent: true,
    signal,
  });
  if (statusRes.exitCode !== 0) {
    const err = `Failed to get git status from sandbox: ${statusRes.output}`;
    console.error(`[pr] ${err}`);
    return { error: err };
  }

  const changes = parseGitStatusPorcelainV1Z(statusRes.stdout);

  // Step 2: Guards
  const guardResult = validateChangeSet(changes);
  if (!guardResult.ok) {
    console.log(`[pr] ${guardResult.error}`);
    return { error: guardResult.error };
  }

  console.log(`[pr] Detected ${changes.length} changed file(s):`);
  for (const c of changes) {
    console.log(`  - ${c.path} (${c.type})`);
  }

  // Branch and commit details
  const slug = createBranchSlug(request.task);
  const firstLine = request.task.split('\n')[0]?.trim() ?? 'task';
  const commitSubject = `feat: ${firstLine.slice(0, 66)}`;
  const commitBody = 'Generated by software-factory (draft, needs human review)';
  const commitMessage = `${commitSubject}\n\n${commitBody}`;

  const prBody = buildPrBody({
    task: request.task,
    finalSummary: options.finalSummary,
    baseline: options.baseline,
    rounds: options.rounds,
    roundsUsed: options.roundsUsed,
    selfRepairs: options.selfRepairs,
    agentSteps: options.agentSteps,
    tokenUsage: options.tokenUsage,
    cpuUsageMs: options.cpuUsageMs,
    geminiModel: options.geminiModel,
    changes,
  });

  // Handle dry-run
  if (dryRun) {
    const dryRunBranch = `factory/${slug}-${generateRandomId(6)}`;
    console.log('\n=== PR Dry Run ===');
    console.log(`Branch: ${dryRunBranch}`);
    console.log(`Commit Subject: ${commitSubject}`);
    console.log(`\nCommit Message:\n${commitMessage}`);
    console.log(`\nPR Body:\n${prBody}`);
    return {
      branch: dryRunBranch,
    };
  }

  // Live GitHub PR creation
  if (!token) {
    const err = 'Missing required environment variable: GITHUB_PR_TOKEN (required with --pr).';
    console.error(`[pr] ${err}`);
    return { error: err };
  }

  const { owner, repo } = parseGitHubRepo(request.repoUrl);
  const octokit = new Octokit({
    auth: token,
  });

  let currentStep = 'validate repository';
  let branchCreated = false;
  let branchName = '';

  try {
    // Verify target repo is a fork owned by the authenticated user
    currentStep = 'verify fork ownership';
    const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
    if (!repoData.fork) {
      throw new Error(
        `Target repository "${owner}/${repo}" is not a fork. PR creation is only permitted on a fork you own.`,
      );
    }

    currentStep = 'verify authenticated user';
    const { data: authUser } = await octokit.rest.users.getAuthenticated();
    if (authUser.login.toLowerCase() !== owner.toLowerCase()) {
      throw new Error(
        `Target repository "${owner}/${repo}" is not owned by authenticated GitHub user "${authUser.login}".`,
      );
    }

    if (!repoData.permissions?.push) {
      throw new Error(
        `GitHub token lacks push/write permissions on repository "${owner}/${repo}".`,
      );
    }

    // Step 3: Create Blobs & Tree Entries
    currentStep = 'create blobs';
    const treeEntries: Array<{
      path: string;
      mode: '100644' | '100755' | '120000';
      type: 'blob';
      sha: string | null;
    }> = [];

    for (const change of changes) {
      if (change.type === 'deleted') {
        treeEntries.push({
          path: change.path,
          mode: '100644',
          type: 'blob',
          sha: null,
        });
        continue;
      }

      const fullPath = path.posix.join(repoDir, change.path);
      const stats = await sandbox.fs.lstat(fullPath);

      let mode: '100644' | '100755' | '120000' = '100644';
      let base64Content = '';

      if (stats.isSymbolicLink()) {
        mode = '120000';
        const target = await sandbox.fs.readlink(fullPath);
        base64Content = Buffer.from(target, 'utf8').toString('base64');
      } else {
        if (stats.size > MAX_FILE_SIZE_BYTES) {
          throw new Error(
            `File "${change.path}" exceeds size limit of 1 MB (${stats.size} bytes).`,
          );
        }
        const isExec = (stats.mode & 0o111) !== 0;
        mode = isExec ? '100755' : '100644';
        const buffer = await sandbox.fs.readFile(fullPath);
        base64Content = buffer.toString('base64');
      }

      const { data: blob } = await octokit.rest.git.createBlob({
        owner,
        repo,
        content: base64Content,
        encoding: 'base64',
      });

      treeEntries.push({
        path: change.path,
        mode,
        type: 'blob',
        sha: blob.sha,
      });
    }

    // Create Tree
    currentStep = 'create tree';
    const { data: tree } = await octokit.rest.git.createTree({
      owner,
      repo,
      base_tree: baseSha,
      tree: treeEntries,
    });

    // Create Commit
    currentStep = 'create commit';
    const { data: commit } = await octokit.rest.git.createCommit({
      owner,
      repo,
      message: commitMessage,
      tree: tree.sha,
      parents: [baseSha],
      author: {
        name: 'software-factory',
        email: 'noreply@users.noreply.github.com',
      },
      committer: {
        name: 'software-factory',
        email: 'noreply@users.noreply.github.com',
      },
    });

    // Step 4: Create Branch Ref with retry on collision
    currentStep = 'create branch ref';
    let refSuccess = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      branchName = `factory/${slug}-${generateRandomId(6)}`;
      try {
        await octokit.rest.git.createRef({
          owner,
          repo,
          ref: `refs/heads/${branchName}`,
          sha: commit.sha,
        });
        refSuccess = true;
        branchCreated = true;
        break;
      } catch (err: unknown) {
        const status = (err as { status?: number })?.status;
        if (status === 422 && attempt === 1) {
          continue;
        }
        throw err;
      }
    }

    if (!refSuccess) {
      throw new Error(`Failed to create unique branch ref after 2 attempts.`);
    }

    console.log(`[pr] Created branch: ${branchName} (commit: ${commit.sha})`);

    // Step 6: Open Draft Pull Request
    currentStep = 'pulls.create';
    const { data: pr } = await octokit.rest.pulls.create({
      owner,
      repo,
      title: commitSubject,
      head: branchName,
      base: request.ref,
      body: prBody,
      draft: true,
    });

    console.log(`[pr] Draft PR #${pr.number} created: ${pr.html_url}`);

    return {
      url: pr.html_url,
      number: pr.number,
      branch: branchName,
      headSha: commit.sha,
    };
  } catch (err: unknown) {
    const status = (err as { status?: number })?.status;
    const msg = (err as Error)?.message ?? String(err);
    const cleanMsg = redactToken(msg, token);

    let finalErrMsg = '';
    if (branchCreated) {
      finalErrMsg = `Branch "${branchName}" was created on GitHub, but opening the draft PR failed at step "${currentStep}": [${status ?? 'unknown'}] ${cleanMsg}`;
    } else {
      finalErrMsg = `GitHub API error at step "${currentStep}": [${status ?? 'unknown'}] ${cleanMsg}`;
    }

    console.error(`[pr] ${finalErrMsg}`);
    return {
      branch: branchCreated ? branchName : undefined,
      error: finalErrMsg,
    };
  }
}
