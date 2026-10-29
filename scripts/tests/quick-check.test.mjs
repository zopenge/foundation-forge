import assert from 'node:assert/strict';
import test from 'node:test';
import { selectQuickPlan } from '../check-quick.mjs';
import { runQuickCheck } from '../check-quick.mjs';
import { assertFullReceipt } from '../check-release-gate.mjs';
import { collectDistDigests } from '../check-fingerprint.mjs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const packages = [
  { name: 'core', directory: 'packages/core', workspaceDependencies: [], quickTests: ['tests/core.test.ts'] },
  { name: 'leaf', directory: 'packages/leaf', workspaceDependencies: ['core'], quickTests: ['tests/unit.test.ts'] },
  { name: 'other', directory: 'packages/other', workspaceDependencies: [], quickTests: ['tests/unit.test.ts'] },
];
const state = { schemaVersion: 1, environmentDigest: 'env', files: { 'packages/core/src/a.ts': 'a', 'packages/leaf/src/b.ts': 'b' } };
const quick = files => selectQuickPlan({ state, fingerprint: { ...state, files: { ...state.files, ...files } }, packages,
  scriptFiles: ['scripts/tests/quick-check.test.mjs', 'scripts/tests/slow.test.mjs'] });
test('quick 复用传递依赖选择，只运行明确快速集合并保留完整套件为 NOT RUN', () => {
  assert.deepEqual(quick({ 'packages/core/src/a.ts': 'changed' }), { kind: 'quick', packageNames: ['core', 'leaf'],
    scriptFiles: ['scripts/tests/quick-check.test.mjs'], tests: { core: ['tests/core.test.ts'], leaf: ['tests/unit.test.ts'] } });
});
test('quick 真实文件编排只构建影响包、显式报告 NOT RUN，收据逐字节不变且发布拒绝', async t => {
  const base = resolve(import.meta.dirname, '../../.tmp/tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(resolve(base, 'quick-flow-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, 'scripts/tests'), { recursive: true });
  await writeFile(resolve(root, 'scripts/tests/quick-fixture.test.mjs'), '');
  const values = [];
  for (const name of ['leaf', 'other']) {
    const packageRoot = resolve(root, 'packages', name);
    await mkdir(resolve(packageRoot, 'tests'), { recursive: true }); await mkdir(resolve(packageRoot, 'dist'));
    await writeFile(resolve(packageRoot, 'tests/unit.test.mjs'), ''); await writeFile(resolve(packageRoot, 'dist/index.js'), name);
    values.push({ name, directory: `packages/${name}`, packageRoot, workspaceDependencies: [],
      verification: {}, manifest: { scripts: { 'test:coverage': 'vitest run --coverage' } } });
  }
  const old = { schemaVersion: 1, environmentDigest: 'env', files: { 'packages/leaf/src/a.ts': 'old' },
    distDigests: await collectDistDigests(values), validation: { schemaVersion: 1, kind: 'full' } };
  const next = { schemaVersion: 1, environmentDigest: 'env', files: { 'packages/leaf/src/a.ts': 'new' } };
  await mkdir(resolve(root, '.tmp/check-cache'), { recursive: true });
  const path = resolve(root, '.tmp/check-cache/state.json'), receipt = JSON.stringify(old); await writeFile(path, receipt);
  const calls = []; let finalized = 0;
  const options = { repositoryRoot: root, discover: async () => ({ repositoryRoot: root, packages: values }),
    collect: async () => next,
    run: async args => {
      calls.push(args.join(' '));
      if (args.at(-1) === 'build') { await mkdir(resolve(values[0].packageRoot, 'dist')); await writeFile(resolve(values[0].packageRoot, 'dist/index.js'), 'rebuilt'); }
    },
    createContext: async options => { assert.equal(options.workers, 1); return { finalize: async () => { finalized++; } }; },
    scripts: async (_context, options) => { assert.deepEqual(options.files, ['scripts/tests/quick-fixture.test.mjs']); calls.push('scripts'); },
    tests: async options => { assert.deepEqual(options.packages.map(value => value.name), ['leaf']); calls.push('tests'); },
  };
  const result = await runQuickCheck(options);
  assert.deepEqual(calls, ['run lint', '--filter leaf run build', '--filter leaf run typecheck', 'scripts', 'tests']);
  assert.equal(result.full, 'NOT RUN'); assert.equal(result.coverage, 'NOT RUN'); assert.equal(finalized, 1);
  assert.equal(await readFile(path, 'utf8'), receipt);
  assert.throws(() => assertFullReceipt({ state: old, current: next, distDigests: old.distDigests, tarballDigests: {} }), { code: 'FULL_CHECK_REQUIRED' });
  const early = new globalThis.AbortController(), earlyReason = new Error('cancel before first owned stage'); let entered = false;
  await assert.rejects(runQuickCheck({ ...options, signal: early.signal,
    createContext: async () => { entered = true; early.abort(earlyReason); return { cancel: async () => {}, finalize: async () => {} }; },
    run: async () => { assert.equal(entered, true, '普通阶段启动前必须已有受管 context'); early.signal.throwIfAborted(); },
  }), error => error === earlyReason);
  assert.equal(entered, true); assert.equal(await readFile(path, 'utf8'), receipt);
  const controller = new globalThis.AbortController(), reason = new Error('quick finalize cancellation');
  await assert.rejects(runQuickCheck({ ...options, signal: controller.signal,
    createContext: async () => ({ finalize: async () => { controller.abort(reason); } }),
  }), error => error === reason);
  assert.equal(await readFile(path, 'utf8'), receipt);
  await writeFile(resolve(values[0].packageRoot, 'test-process-scope.mjs'), 'export {};\n');
  const beforeSupervisor = calls.length;
  await assert.rejects(runQuickCheck(options), error => error.code === 'FULL_CHECK_REQUIRED'
    && error.details.reason === 'SUPERVISOR_RUNTIME_CHANGED');
  assert.equal(calls.length, beforeSupervisor);
});
test('quick 对集成测试、共享 helper、删除、跨包配置和未知工具输入要求 full', () => {
  for (const files of [{ 'packages/leaf/tests/integration.test.ts': 'new' }, { 'packages/leaf/tests/helpers/a.ts': 'new' },
    { 'packages/leaf/src/hidden.test.ts': 'new' },
    { 'packages/core/src/a.ts': null }, { 'packages/leaf/package.json': 'new' }, { 'scripts/check-runner.mjs': 'new' }])
    assert.equal(quick(files).kind, 'full-required');
  assert.equal(selectQuickPlan({ state: null, fingerprint: state, packages, scriptFiles: [] }).kind, 'full-required');
});
test('quick 精确测试改动只运行所属包；脚本改动加快速回归而不冒充全脚本覆盖', () => {
  assert.deepEqual(quick({ 'packages/leaf/tests/unit.test.ts': 'new' }).packageNames, ['leaf']);
  assert.deepEqual(quick({ 'scripts/tests/slow.test.mjs': 'new' }).scriptFiles,
    ['scripts/tests/quick-check.test.mjs', 'scripts/tests/slow.test.mjs']);
  assert.deepEqual(quick({}).packageNames, []);
});
test('quick 影响选择可使用独立环境摘要，但不放宽 full 环境或未知快速集合', () => {
  const previous = { ...state, selectionEnvironmentDigest: 'same', environmentDigest: 'two-workers' };
  const fingerprint = { ...previous, environmentDigest: 'one-worker' };
  const options = { state: previous, fingerprint, packages, scriptFiles: ['scripts/tests/quick-check.test.mjs'] };
  assert.equal(selectQuickPlan(options).kind, 'quick');
  assert.equal(selectQuickPlan({ ...options, fingerprint: { ...fingerprint, selectionEnvironmentDigest: 'different-node' } }).kind, 'full-required');
  assert.equal(selectQuickPlan({ ...options, scriptFiles: [] }).kind, 'full-required');
});
