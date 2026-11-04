import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { discoverWorkspacePackageModel } from '../workspace-packages.mjs';
import { createTestRunContext } from '../test-run-context.mjs';

for (const phase of ['shard', 'before-write', 'coverage-shard', 'coverage-before-write', 'coverage-failure-cleanup',
  'coverage-failure-falsy', 'merge', 'own-merge', 'own-merge-falsy', 'own-batch', 'own-batch-falsy']) test(`CI ${phase} preserves late cancellation or the primary merge error`, { timeout: 30_000 }, async t => {
  const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
  const model = await discoverWorkspacePackageModel({ repositoryRoot });
  const context = await createTestRunContext({ packages: model.packages, workers: 1, signal: t.signal });
  t.after(() => context.finalize());
  await context.run({ name: `CI finish ${phase}`, command: process.execPath, cwd: repositoryRoot,
    // 组件的Git边界使用合成SHA；只在私有worker中隔离Actions注入，仍执行生产一致性判断。
    env: { ...process.env, GITHUB_SHA: 'a'.repeat(40) },
    args: ['--experimental-test-module-mocks', fileURLToPath(new URL('./fixtures/ci-finish-worker.mjs', import.meta.url)), phase] });
});
