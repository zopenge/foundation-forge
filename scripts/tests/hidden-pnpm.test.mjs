import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve, win32 } from 'node:path';
import { applyPnpmEnvironment, createPnpmEnvironment, installPnpmSpawnPolicy, validatePnpmRuntime } from '../hidden-pnpm/runtime.mjs';
import { openCheckCancellation } from '../check-cancellation.mjs';

test('pnpm lifecycle 适配只补隐藏参数，保留数组、环境、stdio、this、返回值和异常', () => {
  const args = ['/d /s /c', 'node "中文 空格.js" && pnpm run next'];
  const env = { NODE_OPTIONS: 'unchanged input', PATH: 'unchanged path' }, stdio = [0, 1, 2];
  const options = { env, stdio, cwd: 'C:\\中文 空格', windowsVerbatimArguments: true };
  const result = {}, failure = new Error('original failure'), calls = [];
  const commands = { spawn: function (...values) { calls.push({ thisValue: this, values }); return result; },
    spawnSync: () => { throw failure; } };
  const original = commands.spawn;
  const restore = installPnpmSpawnPolicy(commands, () => {});
  assert.equal(commands.spawn('cmd', args, options), result);
  assert.equal(calls[0].thisValue, commands); assert.equal(calls[0].values[1], args);
  assert.equal(calls[0].values[2].env, env); assert.equal(calls[0].values[2].stdio, stdio);
  assert.deepEqual(calls[0].values[2], { ...options, windowsHide: true });
  assert.equal(options.windowsHide, undefined);
  assert.throws(() => commands.spawnSync('cmd', args, options), error => error === failure);
  commands.spawn('node', { cwd: 'C:\\中文 空格' });
  assert.deepEqual(calls[1].values, ['node', { cwd: 'C:\\中文 空格', windowsHide: true }]);
  restore(); assert.equal(commands.spawn, original);
});

test('pnpm 取消门闩在真正调用 spawn 前失败，恢复后原函数不受影响', () => {
  const reason = new Error('cancel'); let calls = 0;
  const commands = { spawn: () => { calls++; }, spawnSync: () => { calls++; } };
  const restore = installPnpmSpawnPolicy(commands, () => { throw reason; });
  assert.throws(() => commands.spawn('cmd', []), error => error === reason);
  assert.throws(() => commands.spawnSync('cmd', []), error => error === reason);
  assert.equal(calls, 0); restore(); commands.spawn(); assert.equal(calls, 1);
});

test('pnpm 适配环境只在本进程传播显式入口和 PATH，保留已有隔离输入', () => {
  const env = { Path: 'C:\\tools;C:\\adapter', NODE_OPTIONS: 'input', NODE_PATH: 'input', TOKEN_PLACEHOLDER: 'not-a-secret' };
  const value = createPnpmEnvironment({ env, cliPath: 'C:\\pnpm\\bin\\pnpm.cjs',
    nodeExecutable: 'C:\\node\\node.exe', directory: 'C:\\adapter' });
  assert.equal(value.Path, 'C:\\adapter;C:\\tools');
  assert.equal(value.npm_execpath, resolve('C:\\adapter', 'pnpm.cjs'));
  assert.equal(value.FORGE_CHECK_REAL_PNPM_CLI, 'C:\\pnpm\\bin\\pnpm.cjs');
  assert.equal(value.NODE_OPTIONS, env.NODE_OPTIONS); assert.equal(value.NODE_PATH, env.NODE_PATH);
  assert.equal(env.npm_execpath, undefined); assert.equal(env.FORGE_CHECK_NODE, undefined);
  assert.equal(win32.basename(value.npm_execpath), 'pnpm.cjs');
});

test('pnpm 版本或实现指纹变化时拒绝应用适配', () => {
  const read = path => path.endsWith('package.json') ? '{"name":"pnpm","version":"10.33.2","bin":{"pnpm":"bin/pnpm.cjs"}}' : path.includes('dist') ? 'bundle' : 'entry';
  assert.throws(() => validatePnpmRuntime({ cliPath: 'C:\\pnpm\\bin\\pnpm.cjs',
    packageManager: 'pnpm@10.33.3', read, digest: () => 'changed' }), /version/u);
  assert.throws(() => validatePnpmRuntime({ cliPath: 'C:\\pnpm\\bin\\pnpm.cjs',
    packageManager: 'pnpm@10.33.2', read, digest: bytes => bytes === 'entry' ? 'b276da51dc8ca5b0d3ee3371695b50fc8b3244b281b091c63a3f082a88dadeb9' : 'changed' }), /bundle/u);
  assert.throws(() => validatePnpmRuntime({ cliPath: 'relative/pnpm.cjs',
    packageManager: 'pnpm@10.33.2', read }), /absolute/u);
});

test('pnpm 入口保留原环境对象并只恢复自己修改的键', () => {
  const env = { Path: 'original', ORIGINAL: 'kept' }, reference = env;
  const restore = applyPnpmEnvironment(env, { ...env, Path: 'adapted', FORGE_CHECK_NODE: 'own node' });
  env.UNRELATED = 'pnpm addition';
  assert.equal(env, reference); assert.equal(env.Path, 'adapted');
  restore();
  assert.deepEqual(env, { Path: 'original', ORIGINAL: 'kept', UNRELATED: 'pnpm addition' });
});

test('check 共享取消文件让子入口拒绝启动，关闭观察器不撤销取消', () => {
  const files = new Set(), watchers = new Map(), listeners = new Map(), env = {};
  const io = { mkdirSync() {}, mkdtempSync: prefix => prefix + 'own',
    existsSync: path => files.has(path),
    writeFileSync: path => { files.add(path); for (const poll of watchers.get(path) ?? []) poll(); },
    watchFile: (path, options, poll) => {
      assert.equal(options.persistent, false);
      const list = watchers.get(path) ?? new Set(); list.add(poll); watchers.set(path, list);
    },
    unwatchFile: (path, poll) => { watchers.get(path).delete(poll); } };
  const events = { on: (name, fn) => {
    const group = listeners.get(name) ?? new Set(); group.add(fn); listeners.set(name, group);
  }, removeListener: (name, fn) => {
    assert.equal(listeners.get(name).delete(fn), true);
    if (listeners.get(name).size === 0) listeners.delete(name);
  } };
  const parent = openCheckCancellation({ env, io, events });
  const child = openCheckCancellation({ env: { ...env }, io, events });
  parent.assertRunning(); child.assertRunning();
  parent.cancel();
  assert.equal(parent.signal.aborted, true); assert.equal(child.signal.aborted, true);
  assert.throws(child.assertRunning, { code: 'FORGE_CHECK_CANCELLED' });
  const late = openCheckCancellation({ env: { ...env }, io, events });
  assert.throws(late.assertRunning, { code: 'FORGE_CHECK_CANCELLED' });
  late.close(); child.close(); parent.close();
  assert.equal(files.size, 1); assert.equal(listeners.size, 0);
  assert.equal(env.FORGE_CHECK_CANCEL_FILE, undefined);
});
test('pnpm 适配保留省略 args 的第三参数，并让 Node 原样拒绝非法参数', () => {
  const calls = [], failure = new Error('invalid original arguments'), options = { stdio: 'pipe' };
  const spawn = (...values) => {
    calls.push(values);
    if (values[1] === 'invalid' || values[2] === null || values[2] === 'invalid') throw failure;
    return {};
  };
  const commands = { spawn, spawnSync: spawn };
  const restore = installPnpmSpawnPolicy(commands, () => {});
  commands.spawn('node', undefined, options);
  assert.deepEqual(calls.pop(), ['node', undefined, { stdio: 'pipe', windowsHide: true }]);
  for (const values of [['node', 'invalid'], ['node', [], null], ['node', [], 'invalid']]) {
    assert.throws(() => commands.spawn(...values), error => error === failure);
    assert.deepEqual(calls.pop(), values);
  }
  restore();
});

const reviewedEntry = 'b276da51dc8ca5b0d3ee3371695b50fc8b3244b281b091c63a3f082a88dadeb9';
const reviewedBundle = 'a04379c877cf74b4cbc585ab3a14fd52eea2d52b5aa0fb854cbd4485cd73b347';
const runtimeFixture = () => ({
  cliPath: 'C:\\pnpm\\bin\\pnpm.cjs', packageManager: 'pnpm@10.33.2',
  read: path => path.endsWith('package.json')
    ? '{"name":"pnpm","version":"10.33.2","bin":{"pnpm":"bin/pnpm.cjs","pnpx":"bin/pnpx.cjs"}}'
    : path.replaceAll('\\', '/').includes('/dist/') ? 'bundle bytes' : 'entry bytes',
  digest: bytes => bytes === 'entry bytes' ? reviewedEntry : reviewedBundle,
});

test('pnpm 固定适配同时接受已审核的真实入口和 bundle', () => {
  assert.equal(validatePnpmRuntime(runtimeFixture()), undefined);
});

test('同安装目录的 pnpx 不能冒充已审核 pnpm 入口', () => {
  assert.throws(() => validatePnpmRuntime({ ...runtimeFixture(), cliPath: 'C:\\pnpm\\bin\\pnpx.cjs' }), /entry/u);
});

test('pnpm manifest 的入口映射不能改指 pnpx', () => {
  const fixture = runtimeFixture(), read = fixture.read;
  assert.throws(() => validatePnpmRuntime({ ...fixture,
    read: path => path.endsWith('package.json')
      ? '{"name":"pnpm","version":"10.33.2","bin":{"pnpm":"bin/pnpx.cjs"}}' : read(path),
  }), /entry/u);
});

test('pnpm 入口字节改变时即使 bundle 不变也拒绝适配', () => {
  const fixture = runtimeFixture(), digest = fixture.digest;
  assert.throws(() => validatePnpmRuntime({ ...fixture,
    digest: bytes => bytes === 'entry bytes' ? 'changed entry' : digest(bytes),
  }), /entry/u);
});

test('pnpm 环境恢复保留严格删除拒绝及 Proxy 原异常', () => {
  const target = {}, restore = applyPnpmEnvironment(target, { OWN: 'temporary' });
  Object.defineProperty(target, 'OWN', { configurable: false });
  assert.throws(restore, error => error instanceof TypeError);
  assert.equal(target.OWN, 'temporary');
  for (const failure of [new Error('delete trap'), undefined, null, false, 0]) {
    const env = new Proxy({}, { deleteProperty: () => { throw failure; } });
    const undo = applyPnpmEnvironment(env, { OWN: 'temporary' });
    assert.throws(undo, error => error === failure);
    assert.equal(env.OWN, 'temporary');
  }
});

test('取消门闩关闭在删除被拒绝时仍移除监听并保留严格失败语义', () => {
  for (const kind of ['non-configurable', 'proxy-false', 'proxy-throw']) {
    const failure = new Error('cancel delete trap'), target = {}, calls = [];
    const env = kind === 'non-configurable' ? target : new Proxy(target, {
      deleteProperty: () => { if (kind === 'proxy-throw') throw failure; return false; },
    });
    const io = { mkdirSync() {}, mkdtempSync: prefix => prefix + 'own',
      existsSync: () => false, writeFileSync() {}, watchFile() {},
      unwatchFile: () => { calls.push('unwatch'); } };
    const events = { on() {}, removeListener: name => { calls.push(name); } };
    const cancellation = openCheckCancellation({ env, io, events });
    if (kind === 'non-configurable') Object.defineProperty(target, 'FORGE_CHECK_CANCEL_FILE', { configurable: false });
    assert.throws(cancellation.close, error => kind === 'proxy-throw' ? error === failure : error instanceof TypeError);
    assert.equal(target.FORGE_CHECK_CANCEL_FILE, cancellation.path);
    assert.deepEqual(calls, ['unwatch', 'SIGINT', 'SIGTERM']);
  }
});
