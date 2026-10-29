import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

test('workspace projects share one hidden pool and retain their own roots and timeouts', async () => {
  const { createWorkspaceVitestBudgetConfig } = await import('../vitest-workspace-budget-config.mjs');
  const root = resolve('.tmp/workspace-config'), packages = ['one', 'two'].map(name => ({ name, packageRoot: resolve(root, name) }));
  const config = await createWorkspaceVitestBudgetConfig({ packages, repositoryRoot: root, jobRoot: resolve(root, 'job'), workers: 1,
    load: async ({ packageRoot }) => ({ root: packageRoot, test: { testTimeout: packageRoot.endsWith('one') ? 100 : 200,
      coverage: { provider: 'v8', reporter: ['text', 'json', 'html'] } } }) });
  assert.equal(config.test.maxWorkers, 1); assert.equal(config.test.fileParallelism, false);
  assert.deepEqual(config.test.projects.map(value => value.test.name), ['one', 'two']);
  assert.deepEqual(config.test.projects.map(value => value.root), packages.map(value => value.packageRoot));
  assert.deepEqual(config.test.projects.map(value => value.test.testTimeout), [100, 200]);
  for (const project of config.test.projects) {
    assert.equal(project.test.pool, config.test.pool);
    assert.equal(project.test.coverage, undefined);
  }
  assert.equal(config.test.coverage.provider, 'v8');
  assert.ok(config.test.coverage.include.every(value => value.endsWith('/src/**/*.ts')));
});

test('workspace coverage refuses a package-specific gate it cannot preserve', async () => {
  const { createWorkspaceVitestBudgetConfig } = await import('../vitest-workspace-budget-config.mjs');
  await assert.rejects(createWorkspaceVitestBudgetConfig({ packages: [{ name: 'one', packageRoot: resolve('.tmp/one') }],
    repositoryRoot: process.cwd(), jobRoot: resolve('.tmp/job'), workers: 1,
    load: async () => ({ test: { coverage: { provider: 'v8', thresholds: { lines: 100 } } } }) }), /WORKSPACE_COVERAGE_CONFIG_UNSUPPORTED/u);
});

test('workspace configuration removes Vitest global overrides before resolving per-package worker limits', async () => {
  const { createWorkspaceVitestBudgetConfig } = await import('../vitest-workspace-budget-config.mjs');
  const root = resolve('.tmp/workspace-config'), env = { VITEST_MAX_WORKERS: '2', FORGE_CHECK_TEST_WORKERS: '2' };
  const packages = [1, 2].map(coverageWorkers => ({ name: `p${coverageWorkers}`, packageRoot: resolve(root, `p${coverageWorkers}`), verification: { coverageWorkers } }));
  const config = await createWorkspaceVitestBudgetConfig({ packages, repositoryRoot: root, jobRoot: resolve(root, 'job'), workers: 2, env,
    load: async ({ workers }) => ({ test: { maxWorkers: workers, fileParallelism: workers > 1, coverage: { provider: 'v8' } } }) });
  assert.equal(env.VITEST_MAX_WORKERS, undefined);
  assert.equal(env.FORGE_CHECK_TEST_WORKERS, '2');
  assert.deepEqual(config.test.projects.map(value => value.test.maxWorkers), [1, 2]);
  assert.deepEqual(config.test.projects.map(value => value.test.fileParallelism), [false, true]);
  assert.equal(config.test.maxWorkers, 2);
});

test('eight shared slots preserve lower package limits without creating separate pools', async () => {
  const { createWorkspaceVitestBudgetConfig } = await import('../vitest-workspace-budget-config.mjs');
  const root = resolve('.tmp/workspace-config');
  const packages = [1, 4, 8].map(coverageWorkers => ({ name: `p${coverageWorkers}`, packageRoot: resolve(root, `p${coverageWorkers}`), verification: { coverageWorkers } }));
  const config = await createWorkspaceVitestBudgetConfig({ packages, repositoryRoot: root, jobRoot: resolve(root, 'job'), workers: 8, env: {},
    load: async ({ workers }) => ({ test: { maxWorkers: workers, coverage: { provider: 'v8' } } }) });
  assert.equal(config.test.maxWorkers, 8);
  assert.deepEqual(config.test.projects.map(value => value.test.maxWorkers), [1, 4, 8]);
  assert.notEqual(config.test.projects[1].test.sequence?.groupOrder, config.test.projects[2].test.sequence?.groupOrder);
  for (const project of config.test.projects) assert.equal(project.test.pool, config.test.pool);
});

test('implicit package limits do not place the workspace into Vitest global serial execution', async () => {
  const { createWorkspaceVitestBudgetConfig } = await import('../vitest-workspace-budget-config.mjs');
  const root = resolve('.tmp/workspace-config'), packages = ['one', 'two'].map(name => ({ name, packageRoot: resolve(root, name) }));
  const config = await createWorkspaceVitestBudgetConfig({ packages, repositoryRoot: root, jobRoot: resolve(root, 'job'), workers: 8, env: {},
    load: async ({ workers }) => ({ test: { maxWorkers: workers, fileParallelism: workers > 1, coverage: { provider: 'v8' } } }) });
  assert.deepEqual(config.test.projects.map(value => value.test.maxWorkers), [8, 8]);
  assert.deepEqual(config.test.projects.map(value => value.test.fileParallelism), [true, true]);
});
