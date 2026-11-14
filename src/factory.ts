import fs from 'node:fs';
import path from 'node:path';
import type { Sandbox } from '@vercel/sandbox';
import {
  runAgent,
  SYSTEM_INSTRUCTIONS,
  SYSTEM_INSTRUCTIONS_BLIND,
} from './agent.js';
import {
  checkSanitySchemaValidateSupported,
  formatChangedFiles,
  runCheckSuite,
  tailOutput,
  type CheckName,
  type CheckResult,
} from './checks.js';
import type { AppConfig } from './config.js';
import type { FactoryRequest } from './request.js';
import { createSandbox, exec, resolveRepoDir } from './sandbox.js';
import {
  inspectStep,
  installStep,
  pnpmStep,
  type StepResult,
} from './steps.js';
import { createSandboxTools, type ToolCallTracker } from './tools.js';
import { handlePr, type PrResult } from './pr.js';

export interface FactoryOptions {
  skipBaseline?: boolean;
  maxRepairRounds?: number;
  denyNetworkAfterInstall?: boolean;
  blind?: boolean;
  injectFault?: boolean;
  pr?: boolean;
  prDryRun?: boolean;
}

export interface RoundCheckStatus {
  exitCode: number;
  passed: boolean;
  preexisting: boolean;
}

export interface RoundRecord {
  round: number;
  checks: Record<string, RoundCheckStatus>;
  gatePassed: boolean;
}

export interface RoundStepTokenUsage {
  round: number;
  step: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface SelfRepairReport {
  count: number;
  checks: string[];
}

export interface RoundTableEntry {
  round: number;
  failingChecks: string[];
  durationMs: number;
  tokens: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface RunReport {
  task: string;
  repoUrl: string;
  ref: string;
  sandboxName: string;
  success: boolean;
  steps: StepResult[];
  baseline: Record<string, { exitCode: number; preexisting: boolean }> | null;
  rounds: RoundRecord[];
  roundsUsed: number;
  agentSteps: number;
  toolCallCounts: Record<string, number>;
  tokenUsage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  topStepsByInputTokens: RoundStepTokenUsage[];
  selfRepairs: SelfRepairReport;
  faultInjected: boolean;
  roundsTable: RoundTableEntry[];
  filesChanged: string[];
  finalSummary: string;
  totalDurationMs: number;
  cpuUsageMs: number | null;
  runDir?: string;
  pr?: PrResult;
}

const MAX_DIFF_PRINT_CHARS = 10_000;

export async function runFactory(
  request: FactoryRequest,
  config: AppConfig,
  options?: FactoryOptions,
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
        const cpuMs =
          stopped.activeCpuDurationMs ?? activeSandbox.activeCpuUsageMs ?? null;
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
  const rounds: RoundRecord[] = [];
  let baselineResults: Record<string, { exitCode: number; preexisting: boolean }> | null =
    null;
  const preexistingMap: Record<string, boolean> = {};

  const tracker: ToolCallTracker = { counts: {} };
  let totalAgentSteps = 0;
  const totalTokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const allStepUsages: RoundStepTokenUsage[] = [];
  const roundsTable: RoundTableEntry[] = [];
  let selfRepairs: SelfRepairReport = { count: 0, checks: [] };
  let faultInjected = false;
  let prResult: PrResult | undefined;
  let finalSummary = '';
  let filesChanged: string[] = [];
  let rawDiff = '';
  let gatePassed = false;
  let roundsUsed = 0;
  let cpuUsageMs: number | null = null;

  const denyNetwork =
    options?.denyNetworkAfterInstall ?? config.denyNetworkAfterInstall;
  const maxRepairRounds = options?.maxRepairRounds ?? config.maxRepairRounds;
  const skipBaseline = options?.skipBaseline ?? false;

  try {
    console.log(`Creating sandbox for ${request.repoUrl} (${request.ref})...`);
    sandbox = await createSandbox(request, config, controller.signal);
    const repoDir = await resolveRepoDir(sandbox, request.repoUrl, controller.signal);
    console.log(`Sandbox ready: ${sandbox.name} (repo: ${repoDir})`);

    // Setup steps: Inspect, setup pnpm, install dependencies
    const inspect = await inspectStep(sandbox, repoDir, controller.signal);
    steps.push(inspect.result);
    if (inspect.result.exitCode !== 0) {
      throw new Error('Inspect step failed.');
    }

    const pnpmRes = await pnpmStep(sandbox, repoDir, controller.signal);
    steps.push(pnpmRes);
    if (pnpmRes.exitCode !== 0) {
      throw new Error('pnpm setup step failed.');
    }

    const installRes = await installStep(sandbox, repoDir, controller.signal);
    steps.push(installRes);
    if (installRes.exitCode !== 0) {
      throw new Error('Dependencies installation step failed.');
    }

    // Optional network lock
    if (denyNetwork) {
      console.log('\n=== Applying Network Policy: deny-all ===');
      await sandbox.update(
        { networkPolicy: 'deny-all' },
        { signal: controller.signal },
      );
      console.log('Network policy set to deny-all.');
    }

    // Check if "sanity schema validate --help" is supported
    console.log('\nChecking if "sanity schema validate --help" is supported...');
    const schemaValidateSupported = await checkSanitySchemaValidateSupported(
      sandbox,
      repoDir,
      controller.signal,
    );
    if (schemaValidateSupported) {
      console.log(
        'Sanity schema validate command is supported. Added to check suite after typegen.',
      );
    } else {
      console.log(
        'Sanity schema validate command is not supported or missing. Skipping.',
      );
    }

    const enabledCheckNames: CheckName[] = [
      'typegen',
      ...(schemaValidateSupported ? (['schema-validate'] as const) : []),
      'check-types',
      'lint',
      'format',
      'test',
    ];

    // Baseline check run
    if (!skipBaseline) {
      console.log('\n=== Baseline Suite (Clean Checkout) ===');
      const baseline = await runCheckSuite(
        sandbox,
        repoDir,
        {},
        config.placeholderEnv,
        false,
        controller.signal,
        enabledCheckNames,
      );

      baselineResults = {};
      for (const [name, res] of Object.entries(baseline.checks)) {
        const preexisting = res.exitCode !== 0;
        preexistingMap[name] = preexisting;
        baselineResults[name] = {
          exitCode: res.exitCode,
          preexisting,
        };
      }
      console.log(
        'Baseline finished. Preexisting failures:',
        Object.keys(preexistingMap).filter((k) => preexistingMap[k]).join(', ') || '(none)',
      );
    } else {
      console.log('\n=== Baseline check suite skipped (--skip-baseline) ===');
    }

    // Initialize agent tools
    const tools = createSandboxTools(
      sandbox,
      repoDir,
      config.placeholderEnv,
      tracker,
    );

    const isBlind = Boolean(options?.blind);
    const round0Tools = isBlind
      ? {
          listFiles: tools.listFiles,
          readFile: tools.readFile,
          writeFile: tools.writeFile,
        }
      : tools;
    const round0Instructions = isBlind
      ? SYSTEM_INSTRUCTIONS_BLIND
      : SYSTEM_INSTRUCTIONS;

    // Track round 0 check calls specifically for selfRepairs
    tracker.checkCalls = [];

    // Initial agent run (Round 0)
    console.log(
      `\n=== Round 0: Agent Ticket Execution${isBlind ? ' [BLIND MODE]' : ''} ===`,
    );
    const round0StartedAt = Date.now();
    const initialPrompt = `Ticket / Task Request:\n${request.task}`;
    const agentResult = await runAgent(
      initialPrompt,
      round0Tools,
      config,
      tracker,
      controller.signal,
      round0Instructions,
    );

    totalAgentSteps += agentResult.stepsCount;
    totalTokenUsage.promptTokens += agentResult.usage.promptTokens;
    totalTokenUsage.completionTokens += agentResult.usage.completionTokens;
    totalTokenUsage.totalTokens += agentResult.usage.totalTokens;
    finalSummary = agentResult.text;
    for (const su of agentResult.stepUsages) {
      allStepUsages.push({
        round: 0,
        step: su.step,
        inputTokens: su.inputTokens,
        outputTokens: su.outputTokens,
        totalTokens: su.totalTokens,
      });
    }

    const round0FailedCheckCalls = (tracker.checkCalls ?? [])
      .filter((c) => c.exitCode !== 0)
      .map((c) => c.name);
    selfRepairs = {
      count: round0FailedCheckCalls.length,
      checks: round0FailedCheckCalls,
    };

    // Optional fault injection before gate
    if (options?.injectFault) {
      const changedStatusRes = await exec(sandbox, {
        cmd: 'git',
        args: ['ls-files', '-m', '-o', '--exclude-standard'],
        cwd: repoDir,
        silent: true,
        signal: controller.signal,
      });
      const changedTsFiles = changedStatusRes.output
        .split('\n')
        .map((l) => l.trim())
        .filter(
          (l) => (l.endsWith('.ts') || l.endsWith('.tsx')) && !l.endsWith('.d.ts'),
        );

      if (changedTsFiles.length > 0 && changedTsFiles[0]) {
        const targetFile = changedTsFiles[0];
        const fullTargetPath = path.posix.join(repoDir, targetFile);
        const existingContent = await sandbox.fs.readFile(fullTargetPath, 'utf8');
        const faultLine = '\nexport const __factoryFault: number = "x";\n';
        await sandbox.fs.writeFile(fullTargetPath, existingContent + faultLine);
        console.log('\nFAULT INJECTED');
        console.log(
          `Deliberate type error injected into ${targetFile}: export const __factoryFault: number = "x";`,
        );
        faultInjected = true;
      } else {
        console.warn(
          '\nWarning: --inject-fault requested but no changed .ts files found to inject into.',
        );
      }
    }

    // Format only the files the agent changed before the gate
    await formatChangedFiles(sandbox, repoDir, controller.signal);

    // Orchestrator gate
    console.log('\n=== Round 0: Orchestrator Gate ===');
    let gateSuite = await runCheckSuite(
      sandbox,
      repoDir,
      preexistingMap,
      config.placeholderEnv,
      false,
      controller.signal,
      enabledCheckNames,
    );

    gatePassed = gateSuite.gatePassed;
    const round0DurationMs = Date.now() - round0StartedAt;
    const round0FailingChecks = Object.values(gateSuite.checks)
      .filter((c) => c.exitCode !== 0 && !c.preexisting)
      .map((c) => c.name);

    rounds.push({
      round: 0,
      checks: toRoundCheckStatus(gateSuite.checks),
      gatePassed,
    });

    roundsTable.push({
      round: 0,
      failingChecks: round0FailingChecks,
      durationMs: round0DurationMs,
      tokens: { ...agentResult.usage },
    });

    // Verify-and-repair loop
    while (!gatePassed && roundsUsed < maxRepairRounds) {
      roundsUsed++;
      console.log(`\n=== Repair Round ${roundsUsed}/${maxRepairRounds} ===`);
      const roundStartedAt = Date.now();

      const failingChecks = Object.values(gateSuite.checks).filter(
        (c) => c.exitCode !== 0 && !c.preexisting,
      );

      const statRes = await exec(sandbox, {
        cmd: 'git',
        args: ['diff', '--stat'],
        cwd: repoDir,
        silent: true,
        signal: controller.signal,
      });
      const gitDiffStat = statRes.output || '(no changes detected)';

      const repairPrompt = [
        `The original ticket was: "${request.task}"`,
        '',
        'Here is the current `git diff --stat` of changes in the repository:',
        gitDiffStat,
        '',
        'The orchestrator verification gate failed with the following check error(s):',
        ...failingChecks.map(
          (c) =>
            `\n--- Check "${c.name}" failed (exit code ${c.exitCode}) ---\n${tailOutput(c.output)}`,
        ),
        '',
        'Please diagnose and fix these failures.',
        '- Read CONVENTIONS.md and CLAUDE.md if you have not already.',
        '- Copy the nearest existing example.',
        '- Never hand-edit generated files, run typegen via runCheck.',
        '- Run checks yourself before finishing using runCheck.',
        '- End with a brief summary of what you fixed and why.',
      ].join('\n');

      const repairResult = await runAgent(
        repairPrompt,
        tools,
        config,
        tracker,
        controller.signal,
        SYSTEM_INSTRUCTIONS,
      );

      totalAgentSteps += repairResult.stepsCount;
      totalTokenUsage.promptTokens += repairResult.usage.promptTokens;
      totalTokenUsage.completionTokens += repairResult.usage.completionTokens;
      totalTokenUsage.totalTokens += repairResult.usage.totalTokens;
      finalSummary = repairResult.text;
      for (const su of repairResult.stepUsages) {
        allStepUsages.push({
          round: roundsUsed,
          step: su.step,
          inputTokens: su.inputTokens,
          outputTokens: su.outputTokens,
          totalTokens: su.totalTokens,
        });
      }

      // Format only the files the agent changed before the gate
      await formatChangedFiles(sandbox, repoDir, controller.signal);

      console.log(`\n=== Round ${roundsUsed}: Orchestrator Gate ===`);
      gateSuite = await runCheckSuite(
        sandbox,
        repoDir,
        preexistingMap,
        config.placeholderEnv,
        false,
        controller.signal,
        enabledCheckNames,
      );

      gatePassed = gateSuite.gatePassed;
      const roundDurationMs = Date.now() - roundStartedAt;
      const roundFailingChecks = Object.values(gateSuite.checks)
        .filter((c) => c.exitCode !== 0 && !c.preexisting)
        .map((c) => c.name);

      rounds.push({
        round: roundsUsed,
        checks: toRoundCheckStatus(gateSuite.checks),
        gatePassed,
      });

      roundsTable.push({
        round: roundsUsed,
        failingChecks: roundFailingChecks,
        durationMs: roundDurationMs,
        tokens: { ...repairResult.usage },
      });

      if (gatePassed) {
        console.log(`\nGate passed in repair round ${roundsUsed}!`);
        break;
      }
    }

    // Inspect files changed
    const diffNamesRes = await exec(sandbox, {
      cmd: 'git',
      args: ['diff', '--name-only'],
      cwd: repoDir,
      silent: true,
      signal: controller.signal,
    });
    filesChanged = diffNamesRes.output
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    // Print capped git diff
    const diffRes = await exec(sandbox, {
      cmd: 'git',
      args: ['diff'],
      cwd: repoDir,
      silent: true,
      signal: controller.signal,
    });

    rawDiff = diffRes.output ?? '';
    let fullDiff = rawDiff;
    if (fullDiff.length > MAX_DIFF_PRINT_CHARS) {
      fullDiff =
        fullDiff.slice(0, MAX_DIFF_PRINT_CHARS) +
        `\n\n[TRUNCATED: git diff capped at ${MAX_DIFF_PRINT_CHARS} characters]`;
    }
    console.log('\n=== Git Diff ===');
    console.log(fullDiff || '(no changes)');

    // Handle PR creation or dry-run if gate passed and PR was requested
    if (gatePassed && !interrupted && (options?.pr || options?.prDryRun)) {
      prResult = await handlePr({
        sandbox,
        repoDir,
        request,
        dryRun: options.prDryRun,
        token: config.githubPrToken,
        geminiModel: config.geminiModel,
        finalSummary,
        baseline: baselineResults,
        rounds,
        roundsUsed,
        selfRepairs,
        agentSteps: totalAgentSteps,
        tokenUsage: totalTokenUsage,
        cpuUsageMs: sandbox.activeCpuUsageMs ?? null,
        signal: controller.signal,
      });
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
    cpuUsageMs = await stopSandboxOnce();
  }

  const success = !interrupted && gatePassed;

  const topStepsByInputTokens = [...allStepUsages]
    .sort((a, b) => b.inputTokens - a.inputTokens)
    .slice(0, 3);

  if (topStepsByInputTokens.length > 0) {
    console.log('\n=== Top 3 Steps by Input Tokens ===');
    for (const [i, s] of topStepsByInputTokens.entries()) {
      console.log(
        `  ${i + 1}. Round ${s.round}, Step ${s.step}: ${s.inputTokens} input tokens (${s.outputTokens} output, ${s.totalTokens} total)`,
      );
    }
  }

  if (roundsTable.length > 0) {
    console.log('\n=== Per-Round Table ===');
    console.table(
      roundsTable.map((r) => ({
        Round: r.round,
        'Failing Checks':
          r.failingChecks.length > 0 ? r.failingChecks.join(', ') : '(none)',
        Duration: `${(r.durationMs / 1000).toFixed(1)}s`,
        'Prompt Tokens': r.tokens.promptTokens,
        'Completion Tokens': r.tokens.completionTokens,
        'Total Tokens': r.tokens.totalTokens,
      })),
    );
    console.log(
      '\n| Round | Failing Checks | Duration | Prompt Tokens | Completion Tokens | Total Tokens |',
    );
    console.log(
      '|-------|----------------|----------|---------------|-------------------|--------------|',
    );
    for (const r of roundsTable) {
      const fc =
        r.failingChecks.length > 0 ? r.failingChecks.join(', ') : '(none)';
      const dur = `${(r.durationMs / 1000).toFixed(1)}s`;
      console.log(
        `| ${r.round} | ${fc} | ${dur} | ${r.tokens.promptTokens} | ${r.tokens.completionTokens} | ${r.tokens.totalTokens} |`,
      );
    }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.resolve(process.cwd(), 'runs', timestamp);
  const relRunDir = path.relative(process.cwd(), runDir).replace(/\\/g, '/');

  const report: RunReport = {
    task: request.task,
    repoUrl: request.repoUrl,
    ref: request.ref,
    sandboxName: sandbox?.name ?? '(not created)',
    success,
    steps,
    baseline: baselineResults,
    rounds,
    roundsUsed,
    agentSteps: totalAgentSteps,
    toolCallCounts: tracker.counts,
    tokenUsage: totalTokenUsage,
    topStepsByInputTokens,
    selfRepairs,
    faultInjected,
    roundsTable,
    filesChanged,
    finalSummary,
    totalDurationMs: Date.now() - totalStartedAt,
    cpuUsageMs,
    runDir: relRunDir,
    ...(options?.pr || options?.prDryRun || prResult ? { pr: prResult } : {}),
  };

  try {
    await fs.promises.mkdir(runDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(runDir, 'report.json'),
      JSON.stringify(report, null, 2),
      'utf8',
    );
    await fs.promises.writeFile(
      path.join(runDir, 'diff.patch'),
      rawDiff,
      'utf8',
    );
    console.log(`\nRun saved to: ${relRunDir}`);
  } catch (err) {
    console.error(`Failed to save run artifacts to ${runDir}:`, err);
  }

  return report;
}

function toRoundCheckStatus(
  checks: Record<string, CheckResult>,
): Record<string, RoundCheckStatus> {
  const out: Record<string, RoundCheckStatus> = {};
  for (const [name, res] of Object.entries(checks)) {
    const preexisting = Boolean(res.preexisting);
    out[name] = {
      exitCode: res.exitCode,
      passed: res.exitCode === 0 || preexisting,
      preexisting,
    };
  }
  return out;
}
