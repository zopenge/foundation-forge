import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import test from 'node:test';
import { runFullCheck } from '../check-full.mjs';
import { runScriptTests, writeState } from '../check-runner.mjs';
import { createTestRunContext } from '../test-run-context.mjs';
import { runTestProcess } from '../test-process-runner.mjs';

const root = resolve(import.meta.dirname, '../..');
const pending = () => {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
};

const contextFixture = async (t, options) => {
  const context = await createTestRunContext(options);
  const owned = await realpath(context.root), identity = await lstat(context.root, { bigint: true });
  const inside = relative(await realpath(resolve(root, '.tmp')), owned);
  assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside));
  t.after(async () => {
    // 只删除本用例已完成 finalize 的注入上下文；失败或未收尾时留下明确证据。
    const summary = JSON.parse(await readFile(resolve(context.root, 'summary.json'), 'utf8'));
    assert.equal(summary.activeWorkers, 0); assert.deepEqual(summary.remainingWorkers, []);
    const current = await lstat(context.root, { bigint: true });
    assert.equal(current.isSymbolicLink(), false);
    assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino);
    assert.equal(await realpath(context.root), owned);
    await rm(owned, { recursive: true, force: true });
  });
  return context;
};

test('已取消的完整入口不启动阶段或创建 context', async () => {
  const control = new globalThis.AbortController(), reason = new Error('cancel before start');
  control.abort(reason);
  let started = 0;
  await assert.rejects(runFullCheck({ signal: control.signal,
    run: async () => { started++; }, verify: async () => { started++; },
    createContext: async () => { started++; },
  }), error => error === reason);
  assert.equal(started, 0);
});

test('完整入口在消费者阶段取消后不启动后续阶段并等待 context 收尾', async () => {
  const control = new globalThis.AbortController(), reason = new Error('cancel consumers');
  const calls = [];
  let receivedSignal, finalized = false;
  const context = { budget: { stop: error => { assert.equal(error, reason); calls.push('stop'); } },
    cancel: async error => { assert.equal(error, reason); calls.push('cancel'); },
    finalize: async () => { finalized = true; calls.push('finalize'); } };
  await assert.rejects(runFullCheck({ signal: control.signal,
    run: async name => { calls.push(name); },
    createContext: async options => { receivedSignal = options.signal; return context; },
    verify: async ({ onBuilt }) => { await onBuilt({ packages: [] }); control.abort(reason); },
    scriptTests: async () => { calls.push('scripts'); }, coverage: async () => { calls.push('coverage'); },
  }), error => error === reason);
  assert.equal(receivedSignal, control.signal);
  assert.equal(finalized, true);
  assert.deepEqual(calls, ['lint', 'stop', 'cancel', 'finalize']);
});

test('增量脚本入口取消后不执行下一阶段或发布成功收据', async () => {
  const control = new globalThis.AbortController(), reason = new Error('cancel lint'), calls = [];
  await assert.rejects(runScriptTests({ signal: control.signal,
    run: async args => { calls.push(args.join(' ')); control.abort(reason); },
    docsValid: async () => { calls.push('docs'); }, persist: async () => { calls.push('persist'); },
  }), error => error === reason);
  assert.deepEqual(calls, ['run lint']);
});

test('pre-abort context 不发现适配器或创建任何 scope', async () => {
  const control = new globalThis.AbortController(), reason = new Error('cancel context');
  control.abort(reason); let started = 0;
  await assert.rejects(createTestRunContext({ packages: [], signal: control.signal,
    supervisor: { provider: { start: () => { started++; } } },
  }), error => error === reason);
  assert.equal(started, 0);
});

test('context 先停止排队与启动权限，再取消活动任务并等待租约回收', async t => {
  const control = new globalThis.AbortController(), reason = new Error('cancel active');
  const entered = pending(), closed = pending(), seen = [];
  let context, closedScope = false;
  context = await contextFixture(t, { packages: [], workers: 1, signal: control.signal,
    supervisor: {},
    runProcess: async spec => {
      seen.push(spec.name);
      spec.signal.addEventListener('abort', () => {
        assert.equal(context.budget.summary().failed, true);
        entered.resolve();
      }, { once: true });
      await closed.promise;
      closedScope = true;
      throw spec.signal.reason;
    },
  });
  const running = context.run({ name: 'active', command: 'never-executed' });
  const queued = context.run({ name: 'queued', command: 'never-executed' });
  const runningRejected = assert.rejects(running, error => error === reason);
  const queuedRejected = assert.rejects(queued, error => error === reason);
  for (let turn = 0; turn < 8 && seen.length === 0; turn++) await Promise.resolve();
  assert.deepEqual(seen, ['active']);
  control.abort(reason); await entered.promise;
  let finalized = false;
  const finalizing = context.finalize().then(value => { finalized = true; return value; });
  await queuedRejected;
  assert.equal(finalized, false);
  assert.equal(closedScope, false);
  await assert.rejects(context.run({ name: 'after-abort', command: 'never-executed' }));
  closed.resolve(); await runningRejected;
  const result = await finalizing;
  assert.equal(result.activeWorkers, 0);
  assert.deepEqual(result.remainingWorkers, []);
  assert.equal(closedScope, true);
  assert.deepEqual(seen, ['active']);
});

test('预算已分配但任务尚未进入时取消，仍然是零 scope', async t => {
  const control = new globalThis.AbortController(), reason = new Error('cancel dispatch');
  let started = 0;
  const context = await contextFixture(t, { packages: [], signal: control.signal, supervisor: {},
    runProcess: async () => { started++; },
  });
  const running = context.run({ name: 'dispatched', command: 'never-executed' });
  control.abort(reason);
  await assert.rejects(running, error => error === reason);
  await context.finalize(); assert.equal(started, 0);
});

test('pre-abort 进程入口不创建日志或 scope，不进行身份读取及授权', async () => {
  const control = new globalThis.AbortController(), reason = new Error('cancel process');
  control.abort(reason); let started = 0, identified = 0;
  await assert.rejects(runTestProcess({ name: 'pre-abort', command: 'never-executed',
    logRoot: resolve(root, '.tmp/tests/pre-abort-must-not-start'),
    signal: control.signal, supervisor: {
      provider: { start: () => { started++; throw new Error('must not start'); } },
      reader: { readIdentity: async () => { identified++; } },
    },
  }), error => error === reason);
  assert.equal(started, 0); assert.equal(identified, 0);
});

test('身份查询期间取消禁止 bind/authorize，等待终止与空 Job 完成才返回', async t => {
  const control = new globalThis.AbortController(), reason = new Error('cancel identity');
  const identityEntered = pending(), identity = pending(), terminated = pending(), completed = pending();
  const calls = [];
  const context = await contextFixture(t, { packages: [], supervisor: {} });
  const logRoot = resolve(context.root, 'injected-process');
  await mkdir(logRoot, { recursive: true });
  const work = runTestProcess({ name: 'cancel-identity', command: 'never-executed', logRoot, signal: control.signal,
    supervisor: { provider: { start: () => ({
      rootPid: Promise.resolve(123),
      bind: async () => { calls.push('bind'); }, authorize: async () => { calls.push('authorize'); },
      terminate: async () => { calls.push('terminate'); await terminated.promise; },
      dispose: async () => { calls.push('dispose'); },
      completion: completed.promise,
    }) }, reader: { readIdentity: async () => { identityEntered.resolve(); return identity.promise; } } },
  });
  let returned = false;
  const rejected = assert.rejects(work, error => {
    returned = true;
    assert.equal(error.cause, reason);
    assert.equal(error.result.closure.empty, true);
    return true;
  });
  await identityEntered.promise; control.abort(reason);
  identity.resolve({ status: 'FOUND', identity: { pid: 123, startToken: 'own-fake' } });
  for (let turn = 0; turn < 8; turn++) await Promise.resolve();
  assert.equal(returned, false);
  assert.deepEqual(calls, ['terminate']);
  terminated.resolve();
  completed.resolve({ exitCode: 0, signal: null, closure: { status: 'closed', empty: true } });
  await rejected;
  assert.deepEqual(calls, ['terminate', 'dispose']);
  const saved = JSON.parse(await readFile(resolve(logRoot, 'process.json'), 'utf8'));
  assert.equal(saved.error.phase, 'identity');
  await context.finalize();
});

test('取消收尾等待直接预算租约的尾部完成，不把 Job 退出当整批退出', async t => {
  const control = new globalThis.AbortController(), reason = new Error('cancel reserved lease');
  const started = pending(), stopProcess = pending(), tail = pending();
  const context = await contextFixture(t, { packages: [], workers: 1, signal: control.signal, supervisor: {},
    runProcess: async spec => { started.resolve(); await stopProcess.promise; throw spec.signal.reason; },
  });
  const work = context.budget.run({ name: 'reserved', workers: 1 }, async lease => {
    try { await context.execute({ name: 'in-lease', command: 'never-executed' }, lease); }
    finally { await tail.promise; }
  });
  const rejected = assert.rejects(work, error => error === reason);
  await started.promise; control.abort(reason); stopProcess.resolve();
  let settled = false, finalFailure;
  const finalizing = context.finalize().then(() => { settled = true; }, error => { settled = true; finalFailure = error; });
  try {
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    assert.equal(settled, false);
  } finally { tail.resolve(); await rejected; await finalizing; }
  assert.equal(finalFailure, undefined);
  assert.equal(context.budget.summary().activeWorkers, 0);
});

test('完整入口在最终 finalize 期间取消时拒绝成功终态', async () => {
  const control = new globalThis.AbortController(), reason = new Error('cancel finalization');
  const calls = [];
  const context = { budget: { stop() {} }, cancel: async () => {},
    finalize: async () => { calls.push('finalize'); control.abort(reason); } };
  await assert.rejects(runFullCheck({ signal: control.signal,
    run: async () => {}, verify: async ({ onBuilt }) => { await onBuilt({ packages: [] }); },
    createContext: async () => context, scriptTests: async () => {}, coverage: async () => {},
  }), error => error === reason);
  assert.deepEqual(calls, ['finalize']);
});

test('Job 在 dispose 期间取消时保存失败终态后才返回', async t => {
  const control = new globalThis.AbortController(), reason = Object.assign(new Error('cancel dispose'), { code: 'LATE_CANCEL' });
  const context = await contextFixture(t, { packages: [], supervisor: {} });
  const logRoot = resolve(context.root, 'late-dispose'), calls = [];
  await assert.rejects(runTestProcess({ name: 'late-dispose', command: 'never-executed', logRoot, signal: control.signal,
    supervisor: { provider: { start: () => ({
      rootPid: Promise.resolve(123), bind: async () => {}, authorize: async () => {},
      terminate: async () => { calls.push('terminate'); },
      dispose: async () => { calls.push('dispose'); control.abort(reason); },
      completion: Promise.resolve({ exitCode: 0, signal: null, closure: { status: 'closed', empty: true } }),
    }) }, reader: { readIdentity: async () => ({ status: 'FOUND', identity: { pid: 123, startToken: 'own-fake' } }) } },
  }), error => {
    assert.equal(error.cause, reason); assert.equal(error.result.error.code, 'LATE_CANCEL');
    assert.equal(error.result.closure.empty, true); return true;
  });
  const saved = JSON.parse(await readFile(resolve(logRoot, 'process.json'), 'utf8'));
  assert.equal(saved.error.code, 'LATE_CANCEL');
  assert.deepEqual(calls, ['dispose']);
  await context.finalize();
});

test('context 在已结束 Job 的输出读取阶段仍拒绝独立 spec 取消', async t => {
  const control = new globalThis.AbortController(), reason = new Error('cancel after process');
  const context = await contextFixture(t, { packages: [], supervisor: {},
    runProcess: async spec => {
      await mkdir(spec.logRoot, { recursive: true });
      await writeFile(resolve(spec.logRoot, 'stdout.log'), '');
      await writeFile(resolve(spec.logRoot, 'stderr.log'), '');
      globalThis.queueMicrotask(() => { control.abort(reason); });
      return { jobId: 'completed-before-cancel', exitCode: 0, signal: null, closure: { status: 'closed', empty: true } };
    },
  });
  await assert.rejects(context.run({ name: 'late-spec', command: 'never-executed', signal: control.signal }),
    error => error === reason);
  const summary = await context.finalize();
  assert.equal(summary.activeWorkers, 0); assert.equal(summary.failed, true);
});

const receiptFixture = ({ onWrite = async () => {}, onClose = async () => {}, onCommit = () => {} } = {}) => {
  const statePath = resolve(root, '.tmp/check-cache/state.json');
  const files = new Map([[statePath, 'previous receipt']]), removed = [], committed = [];
  const io = {
    mkdir: async () => {},
    open: async (path, flag) => {
      assert.equal(flag, 'wx');
      if (files.has(path)) throw Object.assign(new Error('already exists'), { code: 'EEXIST' });
      files.set(path, '');
      return { writeFile: async value => { files.set(path, value); await onWrite(path); },
        close: async () => { await onClose(path); } };
    },
    renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); committed.push(from); onCommit(); },
    rm: async path => { removed.push(path); files.delete(path); },
  };
  return { statePath, files, removed, committed, io };
};

const scriptReceiptOptions = (signal, persist) => ({
  signal, persist, fingerprint: { source: 'verified' }, model: { packages: [] },
  state: { distDigests: {}, tarballDigests: {} }, run: async () => {}, docsValid: async () => {},
  distValid: async () => true, tarballsValid: async () => ({}), assertInputs: async () => {},
});

test('成功收据在异步写入或关闭期间取消时保留旧收据并清理自有暂存', async () => {
  for (const phase of ['onWrite', 'onClose']) {
    const control = new globalThis.AbortController(), reason = new Error('cancel receipt ' + phase);
    const fixture = receiptFixture({ [phase]: async () => { control.abort(reason); } });
    await assert.rejects(runScriptTests(scriptReceiptOptions(control.signal,
      (...args) => writeState(...args, fixture.io))), error => error === reason);
    assert.equal(fixture.files.get(fixture.statePath), 'previous receipt');
    assert.equal(fixture.files.size, 1); assert.equal(fixture.removed.length, 1);
    assert.equal(fixture.committed.length, 0);
  }
});

test('取消运行只删除自己的暂存文件，不回滚另一运行已提交的收据', async () => {
  const control = new globalThis.AbortController(), reason = new Error('cancel first receipt');
  const entered = pending(), resume = pending();
  let first = true;
  const fixture = receiptFixture({ onWrite: async () => {
    if (first) { first = false; entered.resolve(); await resume.promise; }
  } });
  const firstWrite = writeState({ source: 'first' }, {}, {}, control.signal, fixture.io);
  const rejected = assert.rejects(firstWrite, error => error === reason);
  await entered.promise;
  await writeState({ source: 'second' }, {}, {}, undefined, fixture.io);
  control.abort(reason); resume.resolve(); await rejected;
  assert.equal(JSON.parse(fixture.files.get(fixture.statePath)).source, 'second');
  assert.equal(fixture.files.size, 1); assert.equal(fixture.committed.length, 1);
  assert.equal(fixture.removed.length, 1);
  assert.equal(fixture.removed[0] === fixture.committed[0], false);
});

test('未取得暂存文件所有权时不删除同名资源或旧收据', async () => {
  const fixture = receiptFixture(), failure = Object.assign(new Error('exists'), { code: 'EEXIST' });
  fixture.io.open = async () => { throw failure; };
  await assert.rejects(writeState({}, {}, {}, undefined, fixture.io), error => error === failure);
  assert.equal(fixture.files.get(fixture.statePath), 'previous receipt');
  assert.equal(fixture.removed.length, 0); assert.equal(fixture.committed.length, 0);
});

test('同步发布成功后晚到取消不追改已提交收据和成功结果', async () => {
  const control = new globalThis.AbortController(), reason = new Error('cancel after commit');
  const fixture = receiptFixture({ onCommit: () => { globalThis.queueMicrotask(() => { control.abort(reason); }); } });
  await runScriptTests(scriptReceiptOptions(control.signal, (...args) => writeState(...args, fixture.io)));
  assert.equal(control.signal.aborted, true);
  assert.equal(JSON.parse(fixture.files.get(fixture.statePath)).source, 'verified');
  assert.equal(fixture.files.size, 1); assert.equal(fixture.committed.length, 1);
  assert.equal(fixture.removed.length, 0);
});

test('自定义 persist 未返回已提交结果时仍拒绝晚到取消', async () => {
  const control = new globalThis.AbortController(), reason = new Error('cancel uncommitted persist');
  await assert.rejects(runScriptTests(scriptReceiptOptions(control.signal, async () => { control.abort(reason); })),
    error => error === reason);
});

test('取消收据的清理失败仍保留原取消原因及任意收尾异常', async () => {
  for (const cleanup of [new Error('cleanup failed'), undefined, null, false, 0]) {
    const control = new globalThis.AbortController(), reason = new Error('cancel receipt cleanup');
    const fixture = receiptFixture({ onWrite: async () => { control.abort(reason); } });
    fixture.io.rm = async () => { throw cleanup; };
    await assert.rejects(writeState({}, {}, {}, control.signal, fixture.io), error => {
      assert.equal(error instanceof AggregateError, true);
      assert.equal(error.cause, reason);
      assert.equal(error.errors.length, 2);
      assert.equal(error.errors[0], reason);
      assert.equal(error.errors[1], cleanup);
      return true;
    });
    assert.equal(fixture.files.get(fixture.statePath), 'previous receipt');
    assert.equal(fixture.committed.length, 0);
  }
});

test('任务失败且输出读取失败时保留两个异常和原始 cause', async t => {
  const primary = Object.assign(new Error('primary process failure'), { result: { jobId: 'failed-output' } });
  const context = await contextFixture(t, { packages: [], supervisor: {},
    runProcess: async () => { throw primary; },
  });
  await assert.rejects(context.run({ name: 'capture-failure', command: 'never-executed' }), error => {
    assert.equal(error instanceof AggregateError, true);
    assert.equal(error.cause, primary);
    assert.equal(error.errors[0], primary);
    assert.equal(error.errors[1].code, 'ENOENT');
    return true;
  });
  const summary = await context.finalize();
  assert.equal(summary.activeWorkers, 0);
  assert.equal(summary.failed, true);
});

test('取消回归的 context 夹具在完成后回收所属诊断目录', async t => {
  let ownedRoot;
  // 外层仅回收此回归刚创建的假进程夹具，保证观察失败时也不新增残留。
  t.after(async () => { if (ownedRoot) await rm(ownedRoot, { recursive: true, force: true }); });
  await t.test('完成注入 context', async nested => {
    const context = await contextFixture(nested, { packages: [], supervisor: {} });
    ownedRoot = context.root;
    const summary = await context.finalize();
    assert.equal(summary.activeWorkers, 0);
    assert.deepEqual(summary.remainingWorkers, []);
  });
  await assert.rejects(lstat(ownedRoot), { code: 'ENOENT' });
});
