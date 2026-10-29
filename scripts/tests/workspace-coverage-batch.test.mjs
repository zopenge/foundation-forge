import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

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
