import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createWindowEventLedger } from '../../packages/process-control-node/test-window-events.mjs';

test('观察协调器有界采集、延后判断未知窗口并释放消息循环资源，不创建真实 Worker', async () => {
  const source = await readFile(new URL('../../packages/process-control-node/test-window-observer.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('export const createWindowsTestWindowObserver = '), end = source.indexOf('\nif (!isMainThread', start);
  assert.ok(start >= 0 && end > start);
  const timers = new Map(), gaps = [], cleared = [], workers = []; let count = 0, limits, sampled = 0, closed = 0, unsubscribed = 0, samplingSink;
  class FakeWorker extends EventEmitter {
    constructor() { super(); workers.push(this); globalThis.queueMicrotask(() => this.emit('message', { type: 'ready', messageDelivery: true })); }
    postMessage(event) { assert.equal(event.type, 'stop'); globalThis.queueMicrotask(() => this.emit('exit', 0)); }
  }
  const native = {}, sandbox = { Worker: FakeWorker, URL, process: { pid: 900 }, createWindowEventLedger,
    loadOwnedNative: async platform => { assert.equal(platform, 'win32'); return native; },
    createWindowsWindowJobSampler: (value, sink, options) => {
      assert.equal(value, native); limits = options; samplingSink = sink;
      return { sample() { sampled++; }, hasPending: () => false, assigned() {}, closing() {}, close() { closed++; } };
    },
    createWindowsTestJobDiagnostics: value => { assert.equal(value, native); return { observeJobs: () => () => { unsubscribed++; } }; },
    setTimeout: (fn, ms) => { const id = ++count; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => { timers.delete(id); }, setInterval: () => 1, clearInterval: id => cleared.push(id),
    setImmediate: () => assert.fail('no pending sample in this fixture'), clearImmediate() {},
  };
  const expression = source.slice(start, end).replace('export const ', 'const ').replace('new URL(import.meta.url)', '"worker-url"');
  runInNewContext(`${expression}\nglobalThis.create = createWindowsTestWindowObserver;`, sandbox);
  await assert.rejects(sandbox.create({ eventLimit: 0 }), error => error.name === 'RangeError');
  assert.equal(workers.length, 0);
  await assert.rejects(sandbox.create({ memberLimit: 32769 }), error => error.name === 'RangeError');
  assert.equal(workers.length, 0);
  await assert.rejects(sandbox.create({ protectedPids: [20], reusableProtectedPids: [21] }), error => error.name === 'RangeError');
  await assert.rejects(sandbox.create({ protectedPids: [20], reusableProtectedPids: [20], hardProtectedPids: [20] }), error => error.name === 'RangeError');
  await assert.rejects(sandbox.create({ protectedPids: [900], reusableProtectedPids: [900] }), error => error.name === 'RangeError');
  assert.equal(workers.length, 0);
  const observer = await sandbox.create({ eventLimit: 32768, memberLimit: 32768, protectedPids: [20], reusableProtectedPids: [20], onGap: value => gaps.push(value) });
  assert.deepEqual(Array.from(limits.reusableProtectedPids), [20]);
  assert.equal(limits.limit, 32768); assert.equal(sampled, 0);
  workers[0].emit('message', { type: 'window', value: { event: 0x8002, hwnd: '88', pid: 20, at: 200, visible: true, consoleWindow: false } });
  assert.deepEqual(gaps, []);
  const [pendingId, pending] = [...timers.entries()].find(([, value]) => value.ms === 25); assert.ok(pending);
  timers.delete(pendingId); pending.fn();
  assert.deepEqual(gaps, ['UNATTRIBUTED_VISIBLE_WINDOW']);
  samplingSink.gap('JOB_MEMBERS_INCOMPLETE', { rootPid: 10, queryOk: false, assigned: 0, count: 0, capacity: 4096, nativeCode: 87 });
  const report = await observer.close(); assert.equal(report.ready, true);
  assert.equal(closed, 1); assert.equal(unsubscribed, 1); assert.deepEqual(cleared, [1]);
  assert.deepEqual(report.visibleWindows, []); assert.equal(timers.size, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(report.samplingFailures)), [{ reason: 'JOB_MEMBERS_INCOMPLETE', rootPid: 10,
    queryOk: false, assigned: 0, count: 0, capacity: 4096, nativeCode: 87 }]);
});

const coordinatorFixture = async ({ eventLimit = 512, failCleanup = false, outsideProof, pendingSamples = () => [], onSample } = {}) => {
  const source = await readFile(new URL('../../packages/process-control-node/test-window-observer.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('export const createWindowsTestWindowObserver = '), end = source.indexOf('\nif (!isMainThread', start);
  assert.ok(start >= 0 && end > start);
  const timers = new Map(), immediates = new Map(), workers = [], stops = [], gaps = [];
  let next = 0, sink, closes = 0, unsubscribes = 0, samples = 0, snapshotReads = 0, sampleTick;
  class FakeWorker extends EventEmitter {
    constructor() { super(); workers.push(this); globalThis.queueMicrotask(() => this.emit('message', { type: 'ready', messageDelivery: true })); }
    postMessage(event) { stops.push(event.type); globalThis.queueMicrotask(() => this.emit('exit', 0)); }
  }
  const sandbox = { Worker: FakeWorker, URL, process: { pid: 900 }, createWindowEventLedger, loadOwnedNative: async () => ({}),
    createWindowsWindowJobSampler: (_native, value) => {
      sink = value; return { sample() { samples++; onSample?.(samples, sink); }, hasPending: () => pendingSamples(samples).length > 0,
        assigned() {}, closing() {}, outsideProof,
        snapshot: () => { snapshotReads++; return { pendingJobSamples: pendingSamples(samples), membershipTransitions: [] }; },
        close() { closes++; if (failCleanup) throw new Error('fixture sampler close failed'); } };
    },
    createWindowsTestJobDiagnostics: () => ({ observeJobs: () => () => { unsubscribes++; if (failCleanup) throw new Error('fixture unsubscribe failed'); } }),
    setTimeout: (fn, ms) => { const id = ++next; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id),
    setInterval: fn => { sampleTick = fn; return 1; }, clearInterval() {},
    setImmediate: fn => { const id = ++next; immediates.set(id, fn); return id; }, clearImmediate: id => immediates.delete(id),
  };
  const expression = source.slice(start, end).replace('export const ', 'const ').replace('new URL(import.meta.url)', '"worker-url"');
  runInNewContext(`${expression}\nglobalThis.create = createWindowsTestWindowObserver;`, sandbox);
  const observer = await sandbox.create({ eventLimit, onGap: reason => gaps.push(reason) });
  return { observer, timers, immediates, workers, stops, gaps, sink, tick: () => sampleTick(), sampleCount: () => samples,
    snapshotCount: () => snapshotReads, counts: () => ({ closes, unsubscribes }) };
};

test('待确认成员立即最多补一次，持续pending才让出到下一check阶段且只排一个回调', async () => {
  let pending = true;
  const f = await coordinatorFixture({ pendingSamples: () => pending ? [10] : [] });
  try {
    f.tick(); assert.equal(f.immediates.size, 1); assert.equal(f.sampleCount(), 2);
    f.tick(); assert.equal(f.immediates.size, 1); assert.equal(f.sampleCount(), 4);
    const [id, callback] = [...f.immediates.entries()][0]; f.immediates.delete(id);
    pending = false; callback();
    assert.equal(f.sampleCount(), 5); assert.equal(f.immediates.size, 0); assert.deepEqual(f.gaps, []);
  } finally { await f.observer.close(); }
});

test('已知闪窗或关闭立即撤销补采样回调，停止后不再采样', async () => {
  for (const mode of ['flash', 'close']) {
    const f = await coordinatorFixture({ pendingSamples: () => [10] });
    f.tick(); assert.equal(f.immediates.size, 1);
    if (mode === 'flash') {
      f.sink.member({ pid: 20, createdAt: 100 });
      f.workers[0].emit('message', { type: 'window', value: { event: 0x8002, hwnd: '88', pid: 20, at: 200, visible: true } });
    } else await f.observer.close();
    assert.equal(f.immediates.size, 0); f.tick(); assert.equal(f.sampleCount(), 2);
    await f.observer.close();
  }
});

test('同次第二个一致查询不等待事件循环，也不复制完整历史快照来判断pending', async () => {
  const f = await coordinatorFixture({ pendingSamples: samples => samples === 1 ? [10] : [] });
  try {
    f.tick(); assert.equal(f.sampleCount(), 2); assert.equal(f.immediates.size, 0);
    assert.equal(f.snapshotCount(), 0); assert.deepEqual(f.gaps, []);
  } finally { await f.observer.close(); }
});

test('首次或立即补查报缺口均停止后续查询，不重试原生失败', async () => {
  for (const failureAt of [1, 2]) {
    const f = await coordinatorFixture({ pendingSamples: () => [10], onSample: (count, sink) => {
      if (count === failureAt) sink.gap('JOB_MEMBERS_INCOMPLETE');
    } });
    try {
      f.tick(); assert.equal(f.sampleCount(), failureAt); assert.equal(f.immediates.size, 0);
      f.tick(); assert.equal(f.sampleCount(), failureAt); assert.deepEqual(f.gaps, ['JOB_MEMBERS_INCOMPLETE']);
    } finally { await f.observer.close(); }
  }
});

test('采样异常保留有界原因并停止后续查询，仍完成Worker收尾', async () => {
  const f = await coordinatorFixture({ onSample: () => { throw new TypeError('fixture native list argument'); } });
  f.tick(); f.tick();
  assert.equal(f.sampleCount(), 1); assert.deepEqual(f.gaps, ['JOB_WINDOW_SAMPLING_FAILED']);
  const report = await f.observer.close();
  assert.deepEqual(JSON.parse(JSON.stringify(report.samplingFailures)),
    [{ reason: 'JOB_WINDOW_SAMPLING_FAILED', stage: 'sample', nativeException: 'fixture native list argument' }]);
  assert.deepEqual(f.stops, ['stop']);
});

test('采样器和订阅清理抛错仍停止Worker，并让并发close共享完整收尾', async () => {
  const f = await coordinatorFixture({ failCleanup: true });
  f.workers[0].emit('message', { type: 'window', value: { event: 0x8002, hwnd: '88', pid: 20, at: 200, visible: true } });
  const first = f.observer.close(), second = f.observer.close();
  const results = await Promise.allSettled([first, second]);
  assert.deepEqual(results.map(value => value.status), ['fulfilled', 'fulfilled']);
  assert.equal(first, second); assert.deepEqual(f.counts(), { closes: 1, unsubscribes: 1 });
  assert.deepEqual(f.stops, ['stop']); assert.equal(f.timers.size, 0);
  assert.ok(results[0].value.gaps.includes('WINDOW_JOB_UNSUBSCRIBE_FAILED'));
  assert.ok(results[0].value.gaps.includes('WINDOW_MEMBER_CLEANUP_FAILED'));
});

test('协调器只移除已有原生实例证明的归属缺口，证明缺失仍立即停止', async () => {
  for (const proven of [true, false]) {
    const f = await coordinatorFixture({ outsideProof: window => proven ? { ...window, rootPid: 10, created: '123', checkedAt: 210 } : undefined });
    try {
      f.workers[0].emit('message', { type: 'window', value: { event: 0x8002, hwnd: '88', pid: 20, at: 200,
        visible: true, consoleWindow: false, eventThread: 7, windowThread: 7 } });
      const [id, check] = [...f.timers.entries()].find(([, value]) => value.ms === 25);
      f.timers.delete(id); check.fn();
      assert.deepEqual(f.gaps, proven ? [] : ['UNATTRIBUTED_VISIBLE_WINDOW']);
      assert.equal(f.observer.snapshot().outsideJobWindows.length, proven ? 1 : 0);
    } finally { await f.observer.close(); }
  }
});

test('隐藏事件耗尽额度或成员超限均立即取消，停止追加未知窗口计时器', async () => {
  const f = await coordinatorFixture({ eventLimit: 1 });
  try {
    const event = { type: 'window', value: { event: 0x8000, hwnd: '88', pid: 20, at: 200, visible: false } };
    f.workers[0].emit('message', event); f.workers[0].emit('message', event);
    assert.deepEqual(f.gaps, ['EVENT_OVERFLOW']);
    f.workers[0].emit('message', { type: 'window', value: { ...event.value, event: 0x8002, visible: true } });
    assert.equal([...f.timers.values()].filter(value => value.ms === 25).length, 0);
  } finally { await f.observer.close(); }
  const members = await coordinatorFixture({ eventLimit: 1 });
  try {
    members.sink.member({ pid: 21, createdAt: 100 }); members.sink.member({ pid: 22, createdAt: 100 });
    assert.deepEqual(members.gaps, ['MEMBER_OVERFLOW']);
  } finally { await members.observer.close(); }
});
