import test from 'node:test';
import assert from 'node:assert/strict';
import {
  determineOutcome,
  formatDuration,
  formatCpu,
  formatBenchRow,
  calculateMedian,
  calculateTotals,
  formatTotalsMarkdown,
  BenchTicketsFileSchema,
  DEFAULT_BENCH_TICKETS,
  type BenchRow,
} from '../src/bench.js';

test('determineOutcome', () => {
  assert.equal(determineOutcome(true, 0), 'pass in round 0');
  assert.equal(determineOutcome(true, 1), 'pass after repair');
  assert.equal(determineOutcome(true, 2), 'pass after repair');
  assert.equal(determineOutcome(false, 0), 'fail');
  assert.equal(determineOutcome(false, 3), 'fail');
});

test('formatDuration', () => {
  assert.equal(formatDuration(0), '0.0s');
  assert.equal(formatDuration(45200), '45.2s');
  assert.equal(formatDuration(1234), '1.2s');
});

test('formatCpu', () => {
  assert.equal(formatCpu(null), '0.00s');
  assert.equal(formatCpu(Number.NaN), '0.00s');
  assert.equal(formatCpu(1234), '1.23s');
  assert.equal(formatCpu(260901), '260.90s');
});

test('calculateMedian', () => {
  assert.equal(calculateMedian([]), 0);
  assert.equal(calculateMedian([10]), 10);
  assert.equal(calculateMedian([20, 10]), 15);
  assert.equal(calculateMedian([30, 10, 20]), 20);
  assert.equal(calculateMedian([40, 10, 20, 30]), 25);
  assert.equal(calculateMedian([50, 10, 30, 20, 40]), 30);
});

test('calculateTotals & formatTotalsMarkdown', () => {
  const rows: BenchRow[] = [
    {
      id: 'ticket-1',
      outcome: 'pass in round 0',
      roundsUsed: 0,
      selfRepairs: 0,
      durationMs: 40000,
      tokens: 10000,
      cpuUsageMs: 2000,
      filesChangedCount: 2,
    },
    {
      id: 'ticket-2',
      outcome: 'pass after repair',
      roundsUsed: 1,
      selfRepairs: 1,
      durationMs: 60000,
      tokens: 20000,
      cpuUsageMs: 4000,
      filesChangedCount: 3,
    },
  ];

  const totals = calculateTotals(rows);
  assert.equal(totals.totalCount, 2);
  assert.equal(totals.passedCount, 2);
  assert.equal(totals.passRate, 100);
  assert.equal(totals.medianDurationMs, 50000);
  assert.equal(totals.medianTokens, 15000);
  assert.equal(totals.totalCpuMs, 6000);

  const md = formatTotalsMarkdown(totals);
  assert.ok(md.includes('## Totals'));
  assert.ok(md.includes('Pass rate: 100.0% (2/2)'));
  assert.ok(md.includes('Median duration: 50.0s'));
  assert.ok(md.includes('Median tokens: 15000'));
  assert.ok(md.includes('Total CPU: 6.00s'));
});

test('formatBenchRow', () => {
  const row: BenchRow = {
    id: 'ticket-1',
    outcome: 'pass in round 0',
    roundsUsed: 0,
    selfRepairs: 0,
    durationMs: 45200,
    tokens: 12345,
    cpuUsageMs: 3120,
    filesChangedCount: 2,
  };

  const formatted = formatBenchRow(row);
  assert.equal(
    formatted,
    '| ticket-1 | pass in round 0 | 0 | 0 | 45.2s | 12345 | 3.12s | 2 |',
  );
});

test('DEFAULT_BENCH_TICKETS validation', () => {
  const parsed = BenchTicketsFileSchema.parse(DEFAULT_BENCH_TICKETS);
  assert.equal(parsed.length, 6);
  assert.equal(parsed[0]?.id, 'ticket-1');
  assert.ok(parsed[0]?.task.length > 0);
});

test('mainBench --help prints usage without error', async () => {
  const { mainBench } = await import('../src/bench.js');
  const prevCode = process.exitCode;
  try {
    await mainBench(['--help']);
    assert.equal(process.exitCode, prevCode);
  } finally {
    process.exitCode = prevCode;
  }
});

test('mainBench invalid --only sets exitCode 1', async () => {
  const { mainBench } = await import('../src/bench.js');
  const prevCode = process.exitCode;
  try {
    await mainBench(['--only', 'non-existent-ticket-id']);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = prevCode;
  }
});

test('mainBench invalid --max-tickets sets exitCode 1', async () => {
  const { mainBench } = await import('../src/bench.js');
  const prevCode = process.exitCode;
  try {
    await mainBench(['--max-tickets', 'not-a-number']);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = prevCode;
  }
});
