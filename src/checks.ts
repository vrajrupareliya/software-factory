import path from 'node:path';
import type { Sandbox } from '@vercel/sandbox';
import { exec, type ExecResult } from './sandbox.js';

export type CheckName =
  | 'typegen'
  | 'schema-validate'
  | 'check-types'
  | 'lint'
  | 'format'
  | 'test';

export interface CheckItem {
  readonly name: CheckName;
  readonly command: string;
  readonly timeout: number;
}

export const CHECKS: readonly CheckItem[] = [
  {
    name: 'typegen',
    command: 'pnpm --filter studio extract && pnpm type',
    timeout: 3 * 60 * 1000,
  },
  {
    name: 'schema-validate',
    command: 'pnpm --filter studio exec sanity schema validate',
    timeout: 2 * 60 * 1000,
  },
  {
    name: 'check-types',
    command: 'pnpm check-types',
    timeout: 3 * 60 * 1000,
  },
  {
    name: 'lint',
    command: 'pnpm lint',
    timeout: 2 * 60 * 1000,
  },
  {
    name: 'format',
    command: 'pnpm exec biome format <changed-files>',
    timeout: 2 * 60 * 1000,
  },
  {
    name: 'test',
    command: 'pnpm test',
    timeout: 3 * 60 * 1000,
  },
] as const;

export interface CheckResult {
  name: CheckName;
  exitCode: number;
  output: string;
  durationMs: number;
  preexisting?: boolean;
}

const MAX_OUTPUT_CHARS = 8000;

export const BIOME_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
  '.json',
  '.jsonc',
  '.css',
  '.graphql',
  '.gql',
]);

export function tailOutput(output: string, maxChars = MAX_OUTPUT_CHARS): string {
  if (output.length <= maxChars) return output;
  return output.slice(-maxChars);
}

export async function checkSanitySchemaValidateSupported(
  sandbox: Sandbox,
  repoDir: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const res = await exec(sandbox, {
    cmd: 'pnpm',
    args: ['--filter', 'studio', 'exec', 'sanity', 'schema', 'validate', '--help'],
    cwd: repoDir,
    silent: true,
    signal,
  });
  return res.exitCode === 0;
}

export async function getChangedBiomeFiles(
  sandbox: Sandbox,
  repoDir: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const res = await exec(sandbox, {
    cmd: 'git',
    args: ['ls-files', '-m', '-o', '--exclude-standard'],
    cwd: repoDir,
    silent: true,
    signal,
  });

  const lines = res.output
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const matched: string[] = [];
  for (const file of lines) {
    const ext = path.posix.extname(file).toLowerCase();
    if (BIOME_EXTENSIONS.has(ext)) {
      const fullPath = path.posix.join(repoDir, file);
      const exists = await sandbox.fs.exists(fullPath, { signal }).catch(() => false);
      if (exists) {
        matched.push(file);
      }
    }
  }
  return matched;
}

export async function formatChangedFiles(
  sandbox: Sandbox,
  repoDir: string,
  signal?: AbortSignal,
): Promise<{ exitCode: number; filesFormatted: string[]; output: string }> {
  const files = await getChangedBiomeFiles(sandbox, repoDir, signal);
  if (files.length === 0) {
    return { exitCode: 0, filesFormatted: [], output: 'No changed files to format.' };
  }

  console.log(`\n[format] Formatting ${files.length} changed file(s) with Biome:`);
  for (const f of files) {
    console.log(`  - ${f}`);
  }

  const res = await exec(sandbox, {
    cmd: 'pnpm',
    args: ['exec', 'biome', 'format', '--write', ...files],
    cwd: repoDir,
    silent: false,
    signal,
  });

  return {
    exitCode: res.exitCode,
    filesFormatted: files,
    output: res.output,
  };
}

export async function runSingleCheck(
  sandbox: Sandbox,
  repoDir: string,
  checkName: CheckName,
  env?: Record<string, string>,
  silent = false,
  signal?: AbortSignal,
): Promise<CheckResult> {
  const item = CHECKS.find((c) => c.name === checkName);
  if (!item) {
    throw new Error(`Unknown check name: ${checkName}`);
  }

  const startedAt = Date.now();
  let exitCode = 0;
  let combinedOutput = '';

  const runCmd = async (
    cmd: string,
    args: string[],
    timeoutMs: number,
  ): Promise<ExecResult> => {
    return exec(sandbox, {
      cmd,
      args,
      cwd: repoDir,
      env: { COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', ...env },
      timeoutMs,
      silent,
      signal,
    });
  };

  if (item.name === 'typegen') {
    const res1 = await runCmd('pnpm', ['--filter', 'studio', 'extract'], item.timeout);
    combinedOutput += res1.output;
    exitCode = res1.exitCode;

    if (exitCode === 0) {
      const res2 = await runCmd('pnpm', ['type'], item.timeout);
      combinedOutput += (combinedOutput ? '\n' : '') + res2.output;
      exitCode = res2.exitCode;
    }
  } else if (item.name === 'schema-validate') {
    const res = await runCmd(
      'pnpm',
      ['--filter', 'studio', 'exec', 'sanity', 'schema', 'validate'],
      item.timeout,
    );
    combinedOutput = res.output;
    exitCode = res.exitCode;
  } else if (item.name === 'check-types') {
    const res = await runCmd('pnpm', ['check-types'], item.timeout);
    combinedOutput = res.output;
    exitCode = res.exitCode;
  } else if (item.name === 'lint') {
    const res = await runCmd('pnpm', ['lint'], item.timeout);
    combinedOutput = res.output;
    exitCode = res.exitCode;
  } else if (item.name === 'format') {
    const changedFiles = await getChangedBiomeFiles(sandbox, repoDir, signal);
    if (changedFiles.length === 0) {
      combinedOutput = 'No changed files to check for formatting.';
      exitCode = 0;
    } else {
      const res = await runCmd(
        'pnpm',
        ['exec', 'biome', 'format', ...changedFiles],
        item.timeout,
      );
      combinedOutput = res.output;
      exitCode = res.exitCode;
    }
  } else if (item.name === 'test') {
    const res = await runCmd('pnpm', ['test'], item.timeout);
    combinedOutput = res.output;
    exitCode = res.exitCode;
  }

  const durationMs = Date.now() - startedAt;

  return {
    name: item.name,
    exitCode,
    output: tailOutput(combinedOutput),
    durationMs,
  };
}

export async function runCheckSuite(
  sandbox: Sandbox,
  repoDir: string,
  preexistingMap?: Record<string, boolean>,
  env?: Record<string, string>,
  silent = false,
  signal?: AbortSignal,
  enabledCheckNames?: CheckName[],
): Promise<{
  checks: Record<string, CheckResult>;
  gatePassed: boolean;
}> {
  const checks: Record<string, CheckResult> = {};
  let gatePassed = true;

  const itemsToRun = enabledCheckNames
    ? CHECKS.filter((c) => enabledCheckNames.includes(c.name))
    : CHECKS;

  for (const item of itemsToRun) {
    if (!silent) {
      console.log(`\n--- Running check: ${item.name} (${item.command}) ---`);
    }

    const result = await runSingleCheck(
      sandbox,
      repoDir,
      item.name,
      env,
      silent,
      signal,
    );

    const preexisting = preexistingMap?.[item.name] ?? false;
    result.preexisting = preexisting;
    checks[item.name] = result;

    const passed = result.exitCode === 0 || preexisting;
    if (!passed) {
      gatePassed = false;
    }

    if (!silent) {
      console.log(
        `--- Finished check: ${item.name} (exitCode=${result.exitCode}, preexisting=${preexisting}, passed=${passed}) ---`,
      );
    }
  }

  return { checks, gatePassed };
}
