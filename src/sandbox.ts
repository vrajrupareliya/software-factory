import path from 'node:path';
import { Sandbox } from '@vercel/sandbox';
import type { AppConfig } from './config.js';
import type { FactoryRequest } from './request.js';

const SANDBOX_TIMEOUT_MS = 30 * 60 * 1000;
const SANDBOX_VCPUS = 2;

export interface ExecOptions {
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  sudo?: boolean;
  signal?: AbortSignal;
  silent?: boolean;
}

export interface ExecResult {
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  output: string;
}

export async function createSandbox(
  request: FactoryRequest,
  config: AppConfig,
  signal?: AbortSignal,
): Promise<Sandbox> {
  const source = config.githubToken
    ? {
        type: 'git' as const,
        url: request.repoUrl,
        revision: request.ref,
        depth: 1,
        username: 'x-access-token',
        password: config.githubToken,
      }
    : {
        type: 'git' as const,
        url: request.repoUrl,
        revision: request.ref,
        depth: 1,
      };

  const authParams =
    config.auth.mode === 'access-token'
      ? {
          token: config.auth.token,
          teamId: config.auth.teamId,
          projectId: config.auth.projectId,
        }
      : {};

  return Sandbox.create({
    ...authParams,
    source,
    persistent: false,
    timeout: SANDBOX_TIMEOUT_MS,
    resources: { vcpus: SANDBOX_VCPUS },
    signal,
  });
}

export async function resolveRepoDir(
  sandbox: Sandbox,
  repoUrl: string,
  signal?: AbortSignal,
): Promise<string> {
  if (await sandbox.fs.exists(path.posix.join(sandbox.cwd, 'package.json'), { signal })) {
    return sandbox.cwd;
  }

  const repoName = new URL(repoUrl).pathname
    .split('/')
    .filter(Boolean)
    .pop()
    ?.replace(/\.git$/, '');

  if (repoName) {
    const candidate = path.posix.join(sandbox.cwd, repoName);
    if (await sandbox.fs.exists(candidate, { signal })) {
      return candidate;
    }
  }

  const entries = await sandbox.fs.readdir(sandbox.cwd, { withFileTypes: true, signal });
  const dir = entries.find((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
  return dir ? path.posix.join(sandbox.cwd, dir.name) : sandbox.cwd;
}

export async function exec(sandbox: Sandbox, options: ExecOptions): Promise<ExecResult> {
  const startedAt = Date.now();
  const result = await sandbox.runCommand({
    cmd: options.cmd,
    args: options.args,
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
    sudo: options.sudo,
    signal: options.signal,
    stdout: options.silent ? undefined : process.stdout,
    stderr: options.silent ? undefined : process.stderr,
  });

  const stdout = await result.stdout().catch(() => '');
  const stderr = await result.stderr().catch(() => '');
  const output = (stdout + (stderr ? (stdout ? '\n' : '') + stderr : '')).trim();

  return {
    exitCode: result.exitCode,
    durationMs: result.durationMs ?? Date.now() - startedAt,
    stdout,
    stderr,
    output,
  };
}
