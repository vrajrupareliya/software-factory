import type { Sandbox } from '@vercel/sandbox';
import { exec } from './sandbox.js';

export interface StepResult {
  name: string;
  exitCode: number;
  durationMs: number;
  note?: string;
}

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const TYPECHECK_CANDIDATES = ['check-types', 'typecheck', 'type-check'] as const;
const PNPM_ENV = { COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' };

async function runStep<T extends { exitCode: number; note?: string }>(
  name: string,
  label: string,
  fn: () => Promise<T>,
): Promise<T & { result: StepResult }> {
  console.log(`\n=== ${label} ===`);
  const startedAt = Date.now();
  const outcome = await fn();
  const durationMs = Date.now() - startedAt;
  const result: StepResult = {
    name,
    exitCode: outcome.exitCode,
    durationMs,
    ...(outcome.note ? { note: outcome.note } : {}),
  };
  console.log(`--- ${label} finished (exitCode=${result.exitCode}, ${durationMs}ms) ---`);
  return { ...outcome, result };
}

export async function inspectStep(
  sandbox: Sandbox,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ result: StepResult; scripts: Record<string, string> }> {
  let scripts: Record<string, string> = {};

  const out = await runStep('inspect', 'Step 1/4: Inspect', async () => {
    const nodeVer = await exec(sandbox, { cmd: 'node', args: ['-v'], cwd, signal });
    if (nodeVer.exitCode !== 0) {
      return { exitCode: nodeVer.exitCode };
    }

    const raw = await sandbox.readFileToBuffer(
      { path: 'package.json', cwd },
      { signal },
    );
    if (!raw) {
      console.error('Error: package.json not found in repository root.');
      return { exitCode: 1 };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch (err) {
      console.error('Error: failed to parse root package.json:', err);
      return { exitCode: 1 };
    }

    if (typeof parsed !== 'object' || parsed === null) {
      console.error('Error: root package.json is not a JSON object.');
      return { exitCode: 1 };
    }

    const pkg = parsed as { packageManager?: unknown; scripts?: unknown };
    const packageManager =
      typeof pkg.packageManager === 'string' ? pkg.packageManager : '(not set)';

    if (typeof pkg.scripts === 'object' && pkg.scripts !== null) {
      scripts = Object.fromEntries(
        Object.entries(pkg.scripts).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      );
    }

    console.log('packageManager:', packageManager);
    console.log('scripts:', JSON.stringify(scripts, null, 2));
    return { exitCode: 0 };
  });

  return { result: out.result, scripts };
}

export async function pnpmStep(
  sandbox: Sandbox,
  cwd: string,
  signal?: AbortSignal,
): Promise<StepResult> {
  const out = await runStep('pnpm', 'Step 2/4: Setup pnpm', async () => {
    let res = await exec(sandbox, { cmd: 'corepack', args: ['enable'], cwd, signal });
    if (res.exitCode !== 0) {
      console.log('corepack enable failed, retrying with sudo...');
      res = await exec(sandbox, { cmd: 'corepack', args: ['enable'], cwd, sudo: true, signal });
    }

    if (res.exitCode !== 0) {
      console.log('corepack enable failed, falling back to npm i -g pnpm...');
      res = await exec(sandbox, { cmd: 'npm', args: ['i', '-g', 'pnpm'], cwd, signal });
      if (res.exitCode !== 0) {
        console.log('npm i -g pnpm failed, retrying with sudo...');
        res = await exec(sandbox, { cmd: 'npm', args: ['i', '-g', 'pnpm'], cwd, sudo: true, signal });
      }
    }

    if (res.exitCode !== 0) {
      return { exitCode: res.exitCode };
    }

    const ver = await exec(sandbox, {
      cmd: 'pnpm',
      args: ['-v'],
      cwd,
      env: PNPM_ENV,
      signal,
    });
    return { exitCode: ver.exitCode };
  });

  return out.result;
}

export async function installStep(
  sandbox: Sandbox,
  cwd: string,
  signal?: AbortSignal,
): Promise<StepResult> {
  const out = await runStep('install', 'Step 3/4: Install dependencies', async () => {
    const res = await exec(sandbox, {
      cmd: 'pnpm',
      args: ['install', '--frozen-lockfile'],
      cwd,
      timeoutMs: INSTALL_TIMEOUT_MS,
      env: PNPM_ENV,
      signal,
    });
    return { exitCode: res.exitCode };
  });

  return out.result;
}

export async function typecheckStep(
  sandbox: Sandbox,
  cwd: string,
  scripts: Record<string, string>,
  signal?: AbortSignal,
): Promise<StepResult> {
  const out = await runStep('typecheck', 'Step 4/4: Typecheck', async () => {
    const scriptName = TYPECHECK_CANDIDATES.find((name) => Object.hasOwn(scripts, name));
    if (!scriptName) {
      console.log(
        `No typecheck script found (looked for: ${TYPECHECK_CANDIDATES.join(', ')}).`,
      );
      const available = Object.keys(scripts);
      console.log(
        'Available scripts:',
        available.length > 0 ? available.join(', ') : '(none)',
      );
      return { exitCode: 1, note: 'No typecheck script found' };
    }

    console.log(`Running "pnpm run ${scriptName}"...`);
    const res = await exec(sandbox, {
      cmd: 'pnpm',
      args: ['run', scriptName],
      cwd,
      env: PNPM_ENV,
      signal,
    });
    return { exitCode: res.exitCode, note: `pnpm run ${scriptName}` };
  });

  return out.result;
}
