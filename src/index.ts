import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { runFactory, type FactoryOptions } from './factory.js';
import { FactoryRequestSchema } from './request.js';

function printUsage(): void {
  console.error(
    'Usage: pnpm dev "<task text>" [options]\n\n' +
      'Options:\n' +
      '  --repo <url>          Target Git repository URL\n' +
      '  --ref <ref>           Target Git branch, commit, or tag\n' +
      '  --max-rounds <n>      Maximum repair rounds (overrides MAX_REPAIR_ROUNDS)\n' +
      '  --skip-baseline       Skip baseline check suite run\n' +
      '  --deny-network        Deny network in sandbox after installation\n' +
      '  --blind               In round 0, agent gets no runCheck and skips self-check instruction\n' +
      '  --inject-fault        Append deliberate TypeScript error before gate to test repair loop\n' +
      '  -h, --help            Show this help message\n',
  );
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      ref: { type: 'string' },
      'max-rounds': { type: 'string' },
      'skip-baseline': { type: 'boolean' },
      'deny-network': { type: 'boolean' },
      blind: { type: 'boolean' },
      'inject-fault': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    printUsage();
    return;
  }

  const task = positionals[0];
  if (!task) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const request = FactoryRequestSchema.parse({
    task,
    repoUrl: values.repo ?? config.defaultRepoUrl,
    ref: values.ref ?? config.defaultRepoRef,
  });

  const parsedMaxRounds = values['max-rounds']
    ? Number.parseInt(values['max-rounds'], 10)
    : undefined;

  const options: FactoryOptions = {
    skipBaseline: values['skip-baseline'],
    maxRepairRounds:
      parsedMaxRounds !== undefined && !Number.isNaN(parsedMaxRounds)
        ? parsedMaxRounds
        : undefined,
    denyNetworkAfterInstall: values['deny-network'],
    blind: values.blind,
    injectFault: values['inject-fault'],
  };

  console.log(`Task: ${request.task}`);
  console.log(`Repo: ${request.repoUrl} (ref: ${request.ref})`);
  console.log(`Auth: ${config.auth.mode}`);
  console.log(`Model: ${config.geminiModel}`);
  console.log(
    `Max repair rounds: ${options.maxRepairRounds ?? config.maxRepairRounds}`,
  );
  console.log(
    `Baseline check: ${options.skipBaseline ? 'skipped' : 'enabled'}`,
  );
  console.log(
    `Deny network after install: ${options.denyNetworkAfterInstall ?? config.denyNetworkAfterInstall}`,
  );
  console.log(`Blind mode: ${options.blind ? 'enabled' : 'disabled'}`);
  console.log(`Inject fault: ${options.injectFault ? 'enabled' : 'disabled'}`);

  const report = await runFactory(request, config, options);

  console.log('\n=== Summary ===');
  console.log(JSON.stringify(report, null, 2));
  if (report.runDir) {
    console.log(`\nRun saved to: ${report.runDir}`);
  }
  process.exitCode = report.success ? 0 : 1;
}

main().catch((err) => {
  console.error('\nFatal error:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
