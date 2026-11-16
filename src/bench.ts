import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { runFactory, type FactoryOptions } from './factory.js';
import { FactoryRequestSchema } from './request.js';

export interface BenchTicket {
  id: string;
  task: string;
}

export const BenchTicketSchema = z.object({
  id: z.string().trim().min(1, 'Ticket id must not be empty'),
  task: z.string().trim().min(1, 'Ticket task must not be empty'),
});

export const BenchTicketsFileSchema = z.array(BenchTicketSchema);

export interface BenchRow {
  id: string;
  outcome: 'pass in round 0' | 'pass after repair' | 'fail';
  roundsUsed: number;
  selfRepairs: number;
  durationMs: number;
  tokens: number;
  cpuUsageMs: number | null;
  filesChangedCount: number;
}

export interface BenchTotals {
  passRate: number;
  passedCount: number;
  totalCount: number;
  medianDurationMs: number;
  medianTokens: number;
  totalCpuMs: number;
}

export const DEFAULT_BENCH_TICKETS: BenchTicket[] = [
  {
    id: 'ticket-1',
    task: 'Add a testimonial document type with name, quote and author',
  },
  {
    id: 'ticket-2',
    task: 'Add an author document type with name, avatar image, and bio',
  },
  {
    id: 'ticket-3',
    task: 'Add a faq document type with question and answer fields',
  },
  {
    id: 'ticket-4',
    task: 'Add a category document type with title, slug, and description',
  },
  {
    id: 'ticket-5',
    task: 'Add a siteSettings document type with title, description, and logo',
  },
  {
    id: 'ticket-6',
    task: 'Add a callToAction object type with label, url, and style fields',
  },
];

export function determineOutcome(
  success: boolean,
  roundsUsed: number,
): 'pass in round 0' | 'pass after repair' | 'fail' {
  if (!success) {
    return 'fail';
  }
  return roundsUsed === 0 ? 'pass in round 0' : 'pass after repair';
}

export function formatDuration(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

export function formatCpu(cpuUsageMs: number | null): string {
  if (cpuUsageMs === null || Number.isNaN(cpuUsageMs)) {
    return '0.00s';
  }
  return `${(cpuUsageMs / 1000).toFixed(2)}s`;
}

export function formatBenchRow(row: BenchRow): string {
  return `| ${row.id} | ${row.outcome} | ${row.roundsUsed} | ${row.selfRepairs} | ${formatDuration(row.durationMs)} | ${row.tokens} | ${formatCpu(row.cpuUsageMs)} | ${row.filesChangedCount} |`;
}

export function calculateMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

export function calculateTotals(rows: BenchRow[]): BenchTotals {
  const totalCount = rows.length;
  const passedCount = rows.filter((r) => r.outcome !== 'fail').length;
  const passRate = totalCount > 0 ? (passedCount / totalCount) * 100 : 0;
  const durations = rows.map((r) => r.durationMs);
  const tokens = rows.map((r) => r.tokens);
  const totalCpuMs = rows.reduce((sum, r) => sum + (r.cpuUsageMs ?? 0), 0);

  return {
    passRate,
    passedCount,
    totalCount,
    medianDurationMs: calculateMedian(durations),
    medianTokens: Math.round(calculateMedian(tokens)),
    totalCpuMs,
  };
}

export function formatTotalsMarkdown(totals: BenchTotals): string {
  const passRateStr = `${totals.passRate.toFixed(1)}% (${totals.passedCount}/${totals.totalCount})`;
  const medianDurationStr = formatDuration(totals.medianDurationMs);
  const medianTokensStr = `${totals.medianTokens}`;
  const totalCpuStr = formatCpu(totals.totalCpuMs);

  return [
    '',
    '## Totals',
    '',
    `- Pass rate: ${passRateStr}`,
    `- Median duration: ${medianDurationStr}`,
    `- Median tokens: ${medianTokensStr}`,
    `- Total CPU: ${totalCpuStr}`,
    '',
  ].join('\n');
}

export function printBenchUsage(): void {
  console.error(
    'Usage: pnpm bench [options]\n\n' +
      'Options:\n' +
      '  --only <id>           Run only the specified ticket by ID\n' +
      '  --max-tickets <n>     Maximum number of tickets to run\n' +
      '  --delay <seconds>     Pause seconds between tickets (default: 20 or BENCH_DELAY_SECONDS)\n' +
      '  --repo <url>          Target Git repository URL\n' +
      '  --ref <ref>           Target Git branch, commit, or tag\n' +
      '  --max-rounds <n>      Maximum repair rounds per ticket\n' +
      '  --skip-baseline       Skip baseline check suite run\n' +
      '  --deny-network        Deny network in sandbox after installation\n' +
      '  -h, --help            Show this help message\n',
  );
}

export async function loadOrSeedTickets(ticketsPath: string): Promise<BenchTicket[]> {
  try {
    const raw = await fs.promises.readFile(ticketsPath, 'utf8');
    const parsed = JSON.parse(raw);
    return BenchTicketsFileSchema.parse(parsed);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      await fs.promises.mkdir(path.dirname(ticketsPath), { recursive: true });
      await fs.promises.writeFile(
        ticketsPath,
        JSON.stringify(DEFAULT_BENCH_TICKETS, null, 2) + '\n',
        'utf8',
      );
      return DEFAULT_BENCH_TICKETS;
    }
    throw err;
  }
}

export async function mainBench(args: string[] = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    options: {
      only: { type: 'string' },
      'max-tickets': { type: 'string' },
      delay: { type: 'string' },
      repo: { type: 'string' },
      ref: { type: 'string' },
      'max-rounds': { type: 'string' },
      'skip-baseline': { type: 'boolean' },
      'deny-network': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    printBenchUsage();
    return;
  }

  const ticketsPath = path.resolve(process.cwd(), 'bench', 'tickets.json');
  const resultsPath = path.resolve(process.cwd(), 'bench', 'results.md');

  let tickets = await loadOrSeedTickets(ticketsPath);

  if (values.only) {
    const target = tickets.find((t) => t.id === values.only);
    if (!target) {
      console.error(
        `Error: Ticket "${values.only}" not found in ${ticketsPath}. Available IDs: ${tickets.map((t) => t.id).join(', ')}`,
      );
      process.exitCode = 1;
      return;
    }
    tickets = [target];
  }

  if (values['max-tickets']) {
    const maxTickets = Number.parseInt(values['max-tickets'], 10);
    if (Number.isNaN(maxTickets) || maxTickets < 1) {
      console.error('Error: --max-tickets must be a positive integer.');
      process.exitCode = 1;
      return;
    }
    tickets = tickets.slice(0, maxTickets);
  }

  if (tickets.length === 0) {
    console.error('Error: No tickets to benchmark.');
    process.exitCode = 1;
    return;
  }

  const rawDelay = values.delay ?? process.env.BENCH_DELAY_SECONDS;
  const parsedDelay = rawDelay ? Number.parseInt(rawDelay, 10) : 20;
  const delaySeconds = Number.isNaN(parsedDelay) ? 20 : Math.max(0, parsedDelay);

  const config = loadConfig();

  const parsedMaxRounds = values['max-rounds']
    ? Number.parseInt(values['max-rounds'], 10)
    : undefined;

  const factoryOptions: FactoryOptions = {
    skipBaseline: values['skip-baseline'],
    maxRepairRounds:
      parsedMaxRounds !== undefined && !Number.isNaN(parsedMaxRounds)
        ? parsedMaxRounds
        : undefined,
    denyNetworkAfterInstall: values['deny-network'],
    pr: false,
    prDryRun: false,
  };

  await fs.promises.mkdir(path.dirname(resultsPath), { recursive: true });
  const tableHeader = [
    '# Benchmark Results',
    '',
    '| id | outcome | rounds used | self-repairs | duration | tokens | CPU seconds | files changed |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ].join('\n');
  await fs.promises.writeFile(resultsPath, tableHeader + '\n', 'utf8');

  console.log(`\nStarting Benchmark: ${tickets.length} ticket(s) to run sequentially.`);
  console.log(`Pause between tickets: ${delaySeconds}s (BENCH_DELAY_SECONDS)`);
  console.log(`Results file: ${resultsPath}\n`);
  console.log(tableHeader);

  const rows: BenchRow[] = [];
  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
  };
  process.on('SIGINT', onSigint);

  try {
    for (let i = 0; i < tickets.length; i++) {
      if (interrupted) {
        console.warn('\nBenchmark interrupted by user.');
        break;
      }

      const ticket = tickets[i]!;
      console.log(`\n========================================`);
      console.log(`Running ticket ${i + 1}/${tickets.length}: [${ticket.id}] ${ticket.task}`);
      console.log(`========================================\n`);

      const ticketStartedAt = Date.now();
      let benchRow: BenchRow;

      try {
        const request = FactoryRequestSchema.parse({
          task: ticket.task,
          repoUrl: values.repo ?? config.defaultRepoUrl,
          ref: values.ref ?? config.defaultRepoRef,
        });

        const report = await runFactory(request, config, factoryOptions);
        const durationMs = report.totalDurationMs || Date.now() - ticketStartedAt;
        const outcome = determineOutcome(report.success, report.roundsUsed);

        benchRow = {
          id: ticket.id,
          outcome,
          roundsUsed: report.roundsUsed,
          selfRepairs: report.selfRepairs?.count ?? 0,
          durationMs,
          tokens: report.tokenUsage?.totalTokens ?? 0,
          cpuUsageMs: report.cpuUsageMs ?? null,
          filesChangedCount: report.filesChanged?.length ?? 0,
        };
      } catch (err) {
        console.error(`\nError running ticket [${ticket.id}]:`, err);
        const durationMs = Date.now() - ticketStartedAt;
        benchRow = {
          id: ticket.id,
          outcome: 'fail',
          roundsUsed: 0,
          selfRepairs: 0,
          durationMs,
          tokens: 0,
          cpuUsageMs: null,
          filesChangedCount: 0,
        };
      }

      rows.push(benchRow);
      const rowText = formatBenchRow(benchRow);
      await fs.promises.appendFile(resultsPath, `${rowText}\n`, 'utf8');
      console.log(`\nTicket [${ticket.id}] completed:`);
      console.log(rowText);

      // Pause BENCH_DELAY_SECONDS between tickets
      if (i < tickets.length - 1 && !interrupted && delaySeconds > 0) {
        console.log(`\nPausing ${delaySeconds}s (BENCH_DELAY_SECONDS) before next ticket...`);
        await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
      }
    }
  } finally {
    process.off('SIGINT', onSigint);
  }

  // Calculate and append totals
  const totals = calculateTotals(rows);
  const totalsMarkdown = formatTotalsMarkdown(totals);
  await fs.promises.appendFile(resultsPath, totalsMarkdown, 'utf8');

  console.log('\n=== Totals ===');
  console.log(`Pass rate: ${totals.passRate.toFixed(1)}% (${totals.passedCount}/${totals.totalCount})`);
  console.log(`Median duration: ${formatDuration(totals.medianDurationMs)}`);
  console.log(`Median tokens: ${totals.medianTokens}`);
  console.log(`Total CPU: ${formatCpu(totals.totalCpuMs)}`);
  console.log(`\nBenchmark complete. Results written to ${resultsPath}`);
}

const isMain =
  process.argv[1] &&
  (process.argv[1] === fileURLToPath(import.meta.url) ||
    process.argv[1].endsWith('bench.ts') ||
    process.argv[1].endsWith('bench.js'));

if (isMain) {
  mainBench().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('\nFatal error:', msg);
    process.exitCode = 1;
  });
}
