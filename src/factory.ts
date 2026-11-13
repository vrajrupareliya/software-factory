import type { Sandbox } from '@vercel/sandbox';
import type { AppConfig } from './config.js';
import type { FactoryRequest } from './request.js';
import { createSandbox, resolveRepoDir } from './sandbox.js';
import {
  inspectStep,
  installStep,
  pnpmStep,
  type StepResult,
  typecheckStep,
} from './steps.js';

export interface RunReport {
  task: string;
  repoUrl: string;
  ref: string;
  sandboxName: string;
  success: boolean;
  steps: StepResult[];
  totalDurationMs: number;
  cpuUsageMs: number | null;
}

export async function runFactory(
  request: FactoryRequest,
  config: AppConfig,
): Promise<RunReport> {
  const totalStartedAt = Date.now();
  const controller = new AbortController();
  let sandbox: Sandbox | null = null;
  let stopPromise: Promise<number | null> | null = null;
  let interrupted = false;

  const stopSandboxOnce = (): Promise<number | null> => {
    if (stopPromise) return stopPromise;
    if (!sandbox) return Promise.resolve(null);

    const activeSandbox = sandbox;
    stopPromise = (async () => {
      try {
        const stopped = await activeSandbox.stop();
        const cpuMs = stopped.activeCpuDurationMs ?? activeSandbox.activeCpuUsageMs ?? null;
        console.log(
          `\nSandbox stopped (${activeSandbox.name}). CPU usage: ${cpuMs ?? 'unavailable'} ms`,
        );
        return cpuMs;
      } catch (err) {
        console.error(`Failed to stop sandbox (${activeSandbox.name}):`, err);
        return activeSandbox.activeCpuUsageMs ?? null;
      }
    })();

    return stopPromise;
  };

  const onSigint = () => {
    if (interrupted) return;
    interrupted = true;
    console.error('\nReceived SIGINT, stopping sandbox...');
    controller.abort();
    void stopSandboxOnce();
  };

  process.once('SIGINT', onSigint);

  const steps: StepResult[] = [];
  let cpuUsageMs: number | null = null;

  try {
    console.log(`Creating sandbox for ${request.repoUrl} (${request.ref})...`);
    sandbox = await createSandbox(request, config, controller.signal);
    const repoDir = await resolveRepoDir(sandbox, request.repoUrl, controller.signal);
    console.log(`Sandbox ready: ${sandbox.name} (repo: ${repoDir})`);

    const inspect = await inspectStep(sandbox, repoDir, controller.signal);
    steps.push(inspect.result);

    if (inspect.result.exitCode === 0) {
      const pnpmRes = await pnpmStep(sandbox, repoDir, controller.signal);
      steps.push(pnpmRes);

      if (pnpmRes.exitCode === 0) {
        const installRes = await installStep(sandbox, repoDir, controller.signal);
        steps.push(installRes);

        if (installRes.exitCode === 0) {
          const typecheckRes = await typecheckStep(
            sandbox,
            repoDir,
            inspect.scripts,
            controller.signal,
          );
          steps.push(typecheckRes);
        }
      }
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
    cpuUsageMs = await stopSandboxOnce();
  }

  const success =
    !interrupted && steps.length === 4 && steps.every((step) => step.exitCode === 0);

  return {
    task: request.task,
    repoUrl: request.repoUrl,
    ref: request.ref,
    sandboxName: sandbox?.name ?? '(not created)',
    success,
    steps,
    totalDurationMs: Date.now() - totalStartedAt,
    cpuUsageMs,
  };
}
