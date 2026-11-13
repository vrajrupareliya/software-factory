import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { runFactory } from './factory.js';
import { FactoryRequestSchema } from './request.js';

function printUsage(): void {
  console.error('Usage: pnpm dev "<task text>" [--repo <url>] [--ref <branch-or-sha>]');
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      ref: { type: 'string' },
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

  console.log(`Task: ${request.task}`);
  console.log(`Repo: ${request.repoUrl} (ref: ${request.ref})`);
  console.log(`Auth: ${config.auth.mode}`);

  const report = await runFactory(request, config);

  console.log('\n=== Summary ===');
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.success ? 0 : 1;
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
