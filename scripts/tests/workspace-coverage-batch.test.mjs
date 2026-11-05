import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { createTestWorkerBudget } from '../test-worker-budget.mjs';
import { ensureTestTemporaryDirectory } from '../test-temporary-directory.mjs';
import { discoverWorkspacePackageModel } from '../workspace-packages.mjs';
import { runWorkspaceCoverageBatch } from '../run-workspace-coverage-batch.mjs';

test('one coverage collection partitions every source and assertion into its owning package', async () => {
  const { partitionWorkspaceReports } = await import('../run-workspace-coverage-batch.mjs');
  const packages = ['one', 'two'].map(name => ({ name, packageRoot: resolve('.tmp/batch-coverage', name) }));
  const coverage = Object.fromEntries(packages.map(value => [resolve(value.packageRoot, 'src/index.ts'), { marker: value.name }]));
  const results = { success: true, numFailedTests: 0, numPassedTests: 2, testResults: packages.map(value => ({
    name: resolve(value.packageRoot, 'tests/index.test.ts'), assertionResults: [{ status: 'passed' }, { status: 'pending' }],
  })) };
  const rows = partitionWorkspaceReports(packages, coverage, results);
  assert.deepEqual(rows.map(value => [value.name, value.passed, value.skipped]), [['one', 1, 1], ['two', 1, 1]]);
  assert.deepEqual(rows.flatMap(value => Object.keys(value.coverage)).sort(), Object.keys(coverage).sort());
  for (const row of rows) for (const [path, value] of Object.entries(row.coverage)) assert.equal(value, coverage[path]);
});

test('coverage partitioning rejects an unowned path instead of silently dropping evidence', async () => {
  const { partitionWorkspaceReports } = await import('../run-workspace-coverage-batch.mjs');
  const packages = [{ name: 'one', packageRoot: resolve('.tmp/batch-coverage/one') }];
  assert.throws(() => partitionWorkspaceReports(packages, { [resolve('.tmp/batch-coverage/one-other/src/index.ts')]: {} },
    { success: true, numFailedTests: 0, numPassedTests: 0, testResults: [] }), /WORKSPACE_COVERAGE_UNOWNED/u);
});

test('only the six-of-eight complete batch passes the fast ordering flag to its child', async () => {
  for (const [limit, workers, shard, expected] of [[8, 6, undefined, '1'], [8, 6, '1/2', undefined],
    [8, 8, undefined, undefined], [6, 6, undefined, undefined], [2, 2, undefined, undefined]]) {
    const stop = new Error('inspect launch before executing a process'); let seen = false;
    const context = { root: resolve('.tmp/coverage-order-inspection'), budget: { limit }, run: async spec => {
      seen = true; assert.equal(spec.env.FORGE_CHECK_COVERAGE_FULL_ORDER, expected); assert.equal(spec.workers, workers); throw stop;
    } };
    await assert.rejects(runWorkspaceCoverageBatch({ packages: [], context, workers, shard }), error => error === stop);
    assert.equal(seen, true);
  }
});

test('a six-worker coverage reservation can overlap a consumer without reserving the whole root', async t => {
  const repositoryRoot = resolve(import.meta.dirname, '../..');
  const base = await ensureTestTemporaryDirectory(repositoryRoot, resolve(repositoryRoot, '.tmp/tests'));
  const root = await mkdtemp(resolve(base, 'coverage-allocation-')), identity = await lstat(root, { bigint: true });
  t.after(async () => {
    const current = await lstat(root, { bigint: true });
    assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino); assert.equal(await realpath(root), root);
    await rm(root, { recursive: true });
  });
  const model = await discoverWorkspacePackageModel({ repositoryRoot });
  const selected = model.packages.filter(value => value.manifest.scripts?.['test:coverage']).slice(0, 1);
  const budget = createTestWorkerBudget({ limit: 8 });
  let entered, release, consumerStarted = false;
  const reached = new Promise(accept => { entered = accept; }), closing = new Promise(accept => { release = accept; });
  const context = { root, budget, signal: new globalThis.AbortController().signal, run: spec => budget.run(spec, async () => {
    entered(); await closing;
    await mkdir(spec.logRoot, { recursive: true });
    await writeFile(resolve(spec.logRoot, 'results.json'), JSON.stringify({ success: true, numFailedTests: 0, numPassedTests: 0, testResults: [] }));
  }) };
  const coverage = runWorkspaceCoverageBatch({ packages: selected, context, workers: 6, shard: '1/2' });
  let consumer;
  try {
    await Promise.race([reached, coverage.then(() => { throw new Error('coverage ended before reserving its workers'); })]);
    consumer = budget.run({ name: 'consumer', workers: 1 }, async () => { consumerStarted = true; await closing; });
    await setImmediate(); assert.equal(consumerStarted, true); assert.equal(budget.summary().activeWorkers, 7);
  } finally { release(); await Promise.allSettled([coverage, consumer]); }
  await coverage; await consumer;
  assert.equal(budget.summary().activeWorkers, 0); assert.equal(budget.summary().peakWorkers, 7);
});
