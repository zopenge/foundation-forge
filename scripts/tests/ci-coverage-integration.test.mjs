import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { discoverWorkspacePackageModel } from '../workspace-packages.mjs';
import { createTestRunContext } from '../test-run-context.mjs';
import { ensureTestTemporaryDirectory } from '../test-temporary-directory.mjs';
import { persistCoverageShard, readCoverageShardArtifacts } from '../ci-coverage-shards.mjs';

test('real isolated Vitest shards retain branch coverage across a partial rerun', { timeout: 60_000 }, async t => {
  const { runWorkspaceCoverageBatch, mergeWorkspaceCoverage } = await import('../run-workspace-coverage-batch.mjs');
  assert.equal(typeof mergeWorkspaceCoverage, 'function');
  const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
  const base = await ensureTestTemporaryDirectory(repositoryRoot, resolve(repositoryRoot, 'tmp/ci-shard-tests'));
  const root = await mkdtemp(resolve(base, 'r-')), owned = await lstat(root);
  let context;
  t.after(async () => {
    const failures = [];
    try { await context?.finalize(); } catch (error) { failures.push(error); }
    try {
      const current = await lstat(root);
      if (current.isSymbolicLink() || current.dev !== owned.dev || current.ino !== owned.ino) throw new Error('CI_FIXTURE_IDENTITY_CHANGED');
      await rm(root, { recursive: true, force: true });
    } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'CI shard fixture cleanup failed', { cause: failures[0] });
  });
  const model = await discoverWorkspacePackageModel({ repositoryRoot });
  context = await createTestRunContext({ packages: model.packages, workers: 1, signal: t.signal });
  const packageRoot = resolve(root, 'fixture');
  const packages = [{ name: 'ci-shard-fixture', packageRoot, verification: { coverageWorkers: 1,
    coverageShardWeights: { 'tests/positive.test.ts': 900 } },
    manifest: { scripts: { 'test:coverage': 'vitest run --coverage' } } }];
  const configPath = resolve(root, 'fixture.config.mjs');
  const adapt = current => ({ ...current, run: spec => {
    const args = [...spec.args], index = args.indexOf('--config');
    assert.ok(index >= 0); args[index + 1] = configPath;
    return current.run({ ...spec, args });
  } });
  const adapted = adapt(context);
    await mkdir(resolve(packageRoot, 'src'), { recursive: true });
    await mkdir(resolve(packageRoot, 'tests'));
    await writeFile(resolve(packageRoot, 'src/sign.ts'), "export const sign = (n: number) => n > 0 ? 'positive' : 'non-positive';\n");
    for (const [name, argument, expected] of [['positive', 1, 'positive'], ['negative', -1, 'non-positive']]) {
      await writeFile(resolve(packageRoot, `tests/${name}.test.ts`), `import { it, expect } from 'vitest';
import { sign } from '../src/sign.js';
it(${JSON.stringify(name)}, () => expect(sign(${argument})).toBe(${JSON.stringify(expected)}));
`);
    }
    await writeFile(configPath, `import { resolve } from 'node:path';
import { createUnifiedVitestBudgetConfig } from ${JSON.stringify(new URL('../vitest-unified-budget-config.mjs', import.meta.url).href)};
export default configEnv => createUnifiedVitestBudgetConfig({ repositoryRoot: ${JSON.stringify(repositoryRoot)},
packages: ${JSON.stringify(packages.map(value => ({ packageRoot: value.packageRoot, verification: value.verification })))},
jobRoot: process.env.FORGE_CHECK_JOB_ROOT, workers: 1, configEnv,
load: async () => ({ root: ${JSON.stringify(packageRoot)}, test: { testTimeout: 5000,
coverage: { provider: 'v8', reporter: ['json'], reportsDirectory: resolve(process.env.FORGE_CHECK_JOB_ROOT, 'coverage') } } }) });
`);
    const one = await runWorkspaceCoverageBatch({ packages, context: adapted, shard: '1/2' });
    const two = await runWorkspaceCoverageBatch({ packages, context: adapted, shard: '2/2' });
    const originalAudit = await context.finalize();
    context = await createTestRunContext({ packages: model.packages, workers: 1, signal: t.signal });
    const repeated = await runWorkspaceCoverageBatch({ packages, context: adapt(context), shard: '1/2' });
    assert.equal(one.result.numPassedTests, 1); assert.equal(two.result.numPassedTests, 1);
    assert.equal(one.result.testResults[0].name.replaceAll('\\', '/').endsWith('/positive.test.ts'), true);
    // 部分片不能写出规范coverage；只由完整合并沿原事务发布。
    await assert.rejects(readFile(resolve(packageRoot, 'coverage/coverage-final.json')), { code: 'ENOENT' });
    const audit = await context.finalize();
    const artifactsRoot = resolve(root, 'artifacts');
    const binding = { commit: 'a'.repeat(40), source: 'b'.repeat(64), node: process.version,
      platform: process.platform, architecture: process.arch, workers: 1, run: '42', attempt: '1' };
    const fileNames = batch => batch.result.testResults.map(value => relative(repositoryRoot, value.name).replaceAll('\\', '/'));
    for (const [batch, index, attempt, batchAudit] of [[one, 1, '1', originalAudit], [two, 2, '1', originalAudit], [repeated, 1, '2', audit]]) {
      await persistCoverageShard({ repositoryRoot, directory: artifactsRoot, blob: await readFile(batch.blobPath),
        part: { schemaVersion: 1, kind: 'ci-coverage-shard', shard: { index, count: 2 }, binding: { ...binding, attempt },
          files: fileNames(batch), passed: batch.result.numPassedTests, skipped: batch.result.numPendingTests, audit: batchAudit } });
    }
    const expectedFiles = [...fileNames(one), ...fileNames(two)];
    const artifacts = await readCoverageShardArtifacts({ repositoryRoot, directory: artifactsRoot,
      binding: { ...binding, attempt: '2' }, expectedFiles });
    assert.deepEqual(artifacts.blobs.map(value => value.name), ['part-1-attempt-2.json', 'part-2-attempt-1.json']);
    context = await createTestRunContext({ packages: model.packages, workers: 1, signal: t.signal });
    const blobsDirectory = resolve(root, 'blobs'); await mkdir(blobsDirectory);
    for (const blob of artifacts.blobs) await writeFile(resolve(blobsDirectory, blob.name), blob.bytes);
    const result = await mergeWorkspaceCoverage({ packages, context: adapt(context), blobsDirectory, expected: artifacts.expected });
    assert.equal(result.numPassedTests, 2); assert.equal(result.testResults.length, 2);
    const coverage = JSON.parse(await readFile(resolve(packageRoot, 'coverage/coverage-final.json'), 'utf8'));
    assert.equal(Object.keys(coverage).length, 1);
    assert.ok(Object.values(Object.values(coverage)[0].b).flat().every(hits => hits > 0));
});
