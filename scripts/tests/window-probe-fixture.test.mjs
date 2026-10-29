import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { prepareWindowProbeFixture } from '../../packages/process-control-node/test-window-probe.mjs';

const probeUrl = new URL('../../packages/process-control-node/test-window-probe.mjs', import.meta.url);

test('短探针继承的取消门闩初始不存在，不能预创建空文件冒充未取消', async () => {
  const source = await readFile(probeUrl, 'utf8');
  const start = source.indexOf('    report.cancelFile = '), end = source.indexOf('    report.workStartedAt = ', start);
  assert.ok(start > 0 && end > start);
  const writes = [], report = {};
  await runInNewContext(`(async () => { ${source.slice(start, end)} })()`, {
    report, context: { root: '/owned' }, resolve: (...parts) => parts.join('/'),
    writeFile: async (...args) => { writes.push(args); },
  });
  assert.equal(report.cancelFile, '/owned/cancel.request'); assert.deepEqual(writes, []);
});

test('自包含 Git 夹具的 lifecycle 使用 PATH Node，避免 cmd 双层引号截断带空格的可执行文件', async t => {
  const base = resolve(import.meta.dirname, '../../.tmp/tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(resolve(base, 'window-fixture-'));
  t.after(() => rm(root, { recursive: true }));
  const sha = await prepareWindowProbeFixture(root), manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  assert.match(manifest.scripts['probe:git'], /^node "/u);
  assert.equal(manifest.scripts.probe, 'pnpm run probe:git');
  assert.match(sha, /^[a-f0-9]{40}$/u);
  assert.equal(await readFile(resolve(root, '.git/refs/tags/window-fixture@0.0.0'), 'utf8'), `${sha}\n`);
});

test('取消标记写失败仍触发 abort，事件回调不逸出异常且保留写入错误', async () => {
  const source = await readFile(probeUrl, 'utf8');
  const start = source.indexOf('  const cancel = '), end = source.indexOf('\n  try {', start);
  assert.ok(start > 0 && end > start);
  const report = { cancelFile: '/owned/cancel' }, controller = { signal: { aborted: false }, abort() { this.signal.aborted = true; } };
  const sandbox = { report, controller, writeFileSync: () => { throw new Error('marker write denied'); } };
  runInNewContext(`${source.slice(start, end)}\nglobalThis.cancel = cancel;`, sandbox);
  assert.doesNotThrow(() => sandbox.cancel('work-budget'));
  assert.equal(controller.signal.aborted, true); assert.match(report.cancelMarkerError, /marker write denied/u);
});

test('观察器和夹具清理同时失败仍执行其余收尾并保存最终失败收据', async () => {
  const source = await readFile(probeUrl, 'utf8');
  const start = source.lastIndexOf('  } finally {') + '  } finally {'.length;
  const end = source.indexOf('\n  }\n};', start); assert.ok(start > 0 && end > start);
  const report = { job: { closure: { empty: true } }, fixtureRealPath: '/owned' }; let writes = 0, removals = 0;
  await runInNewContext(`(async () => { ${source.slice(start, end)} })()`, {
    report, reportPath: '/owned/report', workTimer: 1, clearTimeout() {},
    observer: { close: async () => { throw new Error('observer close failed'); } }, fixture: '/owned', identity: { dev: 1, ino: 2 },
    lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => false, dev: 1, ino: 2 }), realpath: async () => '/owned',
    rm: async () => { removals++; throw new Error('directory busy'); },
    writeFile: async (_path, text) => { writes++; assert.equal(JSON.parse(text).cleanupErrors.length, 2); },
    process: { stdout: { write() {} } },
  });
  assert.equal(writes, 1); assert.equal(removals, 1); assert.equal(report.status, 'unconfirmed');
});
