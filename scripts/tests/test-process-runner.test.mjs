import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, rmdir, writeFile, copyFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { setTimeout as startTimer, clearTimeout as stopTimer } from 'node:timers';
import test from 'node:test';
import { createTestWorkerBudget } from '../test-worker-budget.mjs';
import { discoverWorkspacePackageModel } from '../workspace-packages.mjs';
import { createTestRunContext } from '../test-run-context.mjs';

const module = await import('../test-process-runner.mjs').catch(error => ({ error }));
const repositoryRoot = resolve(import.meta.dirname, '../..'), base = resolve(repositoryRoot, '.tmp/tests');
let supervisor;
async function native() {
  assert.ifError(module.error);
  supervisor ??= module.discoverTestProcessSupervisor({ packages: (await discoverWorkspacePackageModel({ repositoryRoot })).packages });
  return supervisor;
}
async function fixture(t, { fakeScope = false } = {}) {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(resolve(base, 'test-process-'));
  t.after(async () => {
    if (fakeScope) {
      // 此替身从未启动 OS 进程；收据只能授权移除本例创建且身份未变的空根。
      const temporary = JSON.parse(await readFile(resolve(root, 'temporary.json'), 'utf8'));
      const inside = relative(resolve(repositoryRoot, '.tmp/test-work'), temporary.path);
      assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside));
      const identity = await lstat(temporary.path, { bigint: true });
      assert.equal(identity.isSymbolicLink(), false); assert.equal(identity.isDirectory(), true);
      assert.equal(String(identity.dev), temporary.device); assert.equal(String(identity.ino), temporary.inode);
      assert.equal(await realpath(temporary.path), temporary.realPath);
      await rmdir(temporary.path);
    }
    const path = relative(base, root); assert.ok(path && !path.startsWith('..') && !isAbsolute(path));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
async function waitJson(path) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await delay(10);
  }
  throw new Error('fixture readiness deadline');
}

async function waitFixtureExit(reader, identity, signal, options = {}) {
  const now = options.now ?? (() => performance.now());
  const pause = options.pause ?? (milliseconds => delay(milliseconds, undefined, { signal }));
  const started = now(); let polls = 0;
  // Job 空与原实例退出分别观察；不重发终止，也不把仍存活或未知当成功。
  while (true) {
    signal?.throwIfAborted();
    const remaining = 1000 - (now() - started);
    assert.ok(remaining > 0, 'fixture exit observation deadline');
    const deadline = new globalThis.AbortController();
    const timer = startTimer(() => deadline.abort(new Error('fixture exit observation deadline')), remaining);
    const readSignal = signal ? globalThis.AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    let observed;
    try { observed = await reader.readIdentity({ pid: identity.pid, signal: readSignal }); polls++; }
    catch (error) {
      signal?.throwIfAborted(); if (deadline.signal.aborted) throw deadline.signal.reason;
      throw error;
    } finally { stopTimer(timer); }
    signal?.throwIfAborted();
    const elapsedMs = now() - started;
    assert.ok(elapsedMs < 1000, `fixture exit observation deadline: ${JSON.stringify({ pid: identity.pid, polls, elapsedMs, observed })}`);
    if (observed.status === 'ABSENT') return { ...observed, polls, elapsedMs };
    assert.equal(observed.status, 'FOUND'); assert.equal(observed.identity.pid, identity.pid);
    if (observed.identity.startToken !== identity.startToken) return { ...observed, polls, elapsedMs };
    await pause(Math.min(20, 1000 - elapsedMs));
  }
}

test('fixture exit observation waits for a fresh absence without terminating again', async t => {
  const identity = { pid: 123, startToken: 'owned' }, calls = [];
  let clock = 0;
  const result = await waitFixtureExit({ readIdentity: async request => {
    calls.push(request); return calls.length === 1 ? { status: 'FOUND', identity } : { status: 'ABSENT' };
  } }, identity, t.signal, { now: () => clock, pause: async milliseconds => { clock += milliseconds; } });
  assert.equal(result.status, 'ABSENT'); assert.equal(calls.length, 2);
  assert.ok(calls.every(request => request.pid === identity.pid && request.signal instanceof globalThis.AbortSignal));
});

test('fixture exit observation rejects a persistently live original instance within its bound', async t => {
  const identity = { pid: 123, startToken: 'owned' }; let clock = 0;
  await assert.rejects(waitFixtureExit({ readIdentity: async () => ({ status: 'FOUND', identity }) }, identity, t.signal,
    { now: () => clock, pause: async milliseconds => { clock += milliseconds; } }), /fixture exit observation deadline/u);
  assert.equal(clock, 1000);
});

test('fixture exit observation retains lookup errors without retrying', async t => {
  const failure = new Error('fixture query failed'); let calls = 0;
  await assert.rejects(waitFixtureExit({ readIdentity: async () => { calls++; throw failure; } },
    { pid: 123, startToken: 'owned' }, t.signal), error => error === failure);
  assert.equal(calls, 1);
});

test('fixture exit observation cancels an in-flight lookup at the remaining deadline', { timeout: 3000 }, async t => {
  let calls = 0, cancelled = false;
  await assert.rejects(waitFixtureExit({ readIdentity: request => new Promise((_accept, reject) => {
    calls++;
    request.signal.addEventListener('abort', () => { cancelled = true; reject(request.signal.reason); }, { once: true });
  }) }, { pid: 123, startToken: 'owned' }, t.signal), /fixture exit observation deadline/u);
  assert.equal(calls, 1); assert.equal(cancelled, true);
});

test('fixture exit observation stops on cancellation before another lookup', async () => {
  const controller = new globalThis.AbortController(), failure = new Error('fixture cancelled'); let calls = 0;
  const identity = { pid: 123, startToken: 'owned' };
  await assert.rejects(waitFixtureExit({ readIdentity: async () => {
    calls++; controller.abort(failure); return { status: 'FOUND', identity };
  } }, identity, controller.signal), error => error === failure);
  assert.equal(calls, 1);
});

test('fixture exit observation never queries after an already cancelled caller', async () => {
  const controller = new globalThis.AbortController(), failure = new Error('fixture cancelled'); let calls = 0;
  controller.abort(failure);
  await assert.rejects(waitFixtureExit({ readIdentity: async () => { calls++; return { status: 'ABSENT' }; } },
    { pid: 123, startToken: 'owned' }, controller.signal), error => error === failure);
  assert.equal(calls, 0);
});

test('fixture exit observation accepts a replacement instance without targeting it', async t => {
  const identity = { pid: 123, startToken: 'replacement' };
  assert.equal((await waitFixtureExit({ readIdentity: async () => ({ status: 'FOUND', identity }) },
    { pid: 123, startToken: 'owned' }, t.signal)).identity.startToken, 'replacement');
});

test('fixture exit observation rejects an absence returned after its own deadline', async t => {
  let clock = 0;
  await assert.rejects(waitFixtureExit({ readIdentity: async () => { clock = 1000; return { status: 'ABSENT' }; } },
    { pid: 123, startToken: 'owned' }, t.signal, { now: () => clock }), /fixture exit observation deadline/u);
});

test('scope setup failure records its phase and bounded structured cause without private output', async t => {
  assert.ifError(module.error);
  const root = await fixture(t);
  const cause = Object.assign(new Error('private machine path'), { name: 'TimeoutError', code: 23 });
  const failure = Object.assign(new Error('private command output'), { name: 'ProcessControlError', code: 'IDENTITY_TEST_FAILED',
    details: { reason: 'identity-deadline', stage: 'OPEN_ROOT', nativeCode: 5, exitCode: 1, private: 'must not persist' }, cause });
  let disposed = false;
  const scope = { rootPid: Promise.resolve(12345),
    completion: Promise.resolve({ exitCode: null, signal: null, closure: { status: 'unknown', reason: 'terminated', empty: true } }),
    dispose: async () => { disposed = true; } };
  await assert.rejects(module.runTestProcess({ supervisor: { provider: { start: () => scope }, reader: { readIdentity: async () => { throw failure; } } },
    name: 'setup-failure', command: 'not-executed', logRoot: root }), error => {
    assert.equal(error.cause, failure); assert.equal(error.result.error.phase, 'identity'); return true;
  });
  const saved = await readFile(resolve(root, 'process.json'), 'utf8'), result = JSON.parse(saved);
  assert.equal(disposed, true); assert.equal(result.error.code, 'IDENTITY_TEST_FAILED');
  assert.equal(result.error.reason, 'identity-deadline'); assert.equal(result.error.cause.code, 23);
  assert.equal(result.error.stage, 'OPEN_ROOT'); assert.equal(result.error.nativeCode, 5); assert.equal(result.error.exitCode, 1);
  assert.doesNotMatch(saved, /private|machine|command output|must not persist/u);
});

test('scope setup failure preserves a falsy rejection before a disposal error', async t => {
  for (const failure of [undefined, null, false, 0]) {
    let temporary;
    // 红测试失败时也只移除本例替身取得的空目录，禁止留下新的诊断残留。
    t.after(async () => { if (temporary) await rmdir(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); });
    await t.test(String(failure), async nested => {
      const root = await fixture(nested, { fakeScope: true });
      await assert.rejects(module.runTestProcess({ name: 'falsy-setup-failure', command: 'not-executed', logRoot: root,
        supervisor: { provider: { start: spec => {
          temporary = spec.environment.FORGE_CHECK_JOB_TEMP;
          return { rootPid: Promise.resolve(12345), dispose: async () => { throw new Error('later cleanup failure'); } };
        } },
          reader: { readIdentity: async () => { throw failure; } } } }), error => {
        assert.equal(error.cause, failure); assert.equal(error.result.error.phase, 'identity');
        assert.equal(error.result.temporary.status, 'retained'); return true;
      });
    });
    await assert.rejects(lstat(temporary), { code: 'ENOENT' });
  }
});

test('a nested execution cannot reuse a busy slot to start another process', { timeout: 30_000 }, async t => {
  const root = await fixture(t), ready = resolve(root, 'ready.json'), finish = resolve(root, 'finish'), forbidden = resolve(root, 'forbidden');
  const context = await createTestRunContext({ packages: (await discoverWorkspacePackageModel({ repositoryRoot })).packages, workers: 1 });
  try {
    await context.budget.run({ name: 'one-slot', workers: 1 }, async lease => {
      const code = 'const f=require("node:fs");f.writeFileSync(process.argv[1],"{}");const t=setInterval(()=>{if(f.existsSync(process.argv[2])){clearInterval(t)}},10)';
      const running = context.execute({ name: 'running', command: process.execPath, args: ['-e', code, ready, finish], cwd: root, signal: t.signal }, lease);
      try {
        await waitJson(ready);
        await assert.rejects(context.finalize(), /worker/u);
        await assert.rejects(context.execute({ name: 'forbidden', command: process.execPath,
          args: ['-e', 'require("node:fs").writeFileSync(process.argv[1],"bad")', forbidden], cwd: root, signal: t.signal }, lease), /worker/u);
        await assert.rejects(readFile(forbidden), { code: 'ENOENT' });
      } finally { await writeFile(finish, 'finish'); await running; }
    });
  } finally { await context.finalize(); }
});

test('a supervised test command binds before execution and drains separate output logs', { timeout: 30_000 }, async t => {
  const control = await native(), root = await fixture(t);
  const result = await module.runTestProcess({ supervisor: control, name: 'normal', logRoot: root,
    command: process.execPath, args: ['-e', 'process.stdout.write("alpha");process.stderr.write("beta")'], cwd: root, signal: t.signal });
  assert.equal(result.exitCode, 0); assert.equal(result.closure.status, 'closed'); assert.equal(result.closure.empty, true);
  assert.equal(await readFile(resolve(root, 'stdout.log'), 'utf8'), 'alpha');
  assert.equal(await readFile(resolve(root, 'stderr.log'), 'utf8'), 'beta');
  assert.equal(JSON.parse(await readFile(resolve(root, 'process.json'), 'utf8')).closure.scopeId, result.closure.scopeId);
});

test('a leftover detached descendant is terminated and cannot turn a failed scope into success', { timeout: 30_000 }, async t => {
  const control = await native(), root = await fixture(t), marker = resolve(root, 'child.json');
  const childCode = `require('node:fs').writeFileSync(process.argv[1],JSON.stringify({pid:process.pid}));setInterval(()=>{},100)`;
  const parentCode = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)},process.argv[1]],{detached:true,stdio:'ignore',windowsHide:true});c.unref();const fs=require('node:fs');const t=setInterval(()=>{if(fs.existsSync(process.argv[1])){clearInterval(t);process.exit(0)}},10);`;
  const work = module.runTestProcess({ supervisor: control, name: 'leftover', logRoot: root, command: process.execPath, args: ['-e', parentCode, marker], cwd: root, signal: t.signal });
  const rejected = assert.rejects(work, error => error.result?.closure.status === 'unknown' && error.result.closure.empty === true);
  const child = await waitJson(marker); await rejected;
  if (process.platform === 'win32') {
    const result = JSON.parse(await readFile(resolve(root, 'process.json'), 'utf8'));
    const member = result.members.find(value => value.pid === child.pid);
    assert.equal(member.belongs, true); assert.match(member.created, /^\d+$/u); assert.equal(member.image, 'node.exe');
  }
  assert.equal((await control.reader.readIdentity({ pid: child.pid })).status, 'ABSENT');
});

test('a real Vitest worker crash closes descendants, drains its sibling and never starts queued work', { timeout: 45_000 }, async t => {
  const control = await native(), root = await fixture(t), ready = resolve(root, 'ready.json'), kill = resolve(root, 'kill');
  await copyFile(resolve(import.meta.dirname, 'fixtures/test-process/crash.test.mjs'), resolve(root, 'crash.test.mjs'));
  await writeFile(resolve(root, 'vitest.config.mjs'), `import {createHiddenVitestPool} from ${JSON.stringify(new URL('../hidden-vitest-pool.mjs', import.meta.url).href)};export default {root:${JSON.stringify(root)},cacheDir:${JSON.stringify(resolve(root, 'cache'))},test:{include:['crash.test.mjs'],pool:createHiddenVitestPool({workers:1}),maxWorkers:1,fileParallelism:false,testTimeout:15000}};`);
  const budget = createTestWorkerBudget({ limit: 2 }); let closeSibling, queued = false, siblingClosed = false;
  const closed = new Promise(accept => { closeSibling = accept; });
  const crash = budget.run({ name: 'crash', workers: 1 }, () => module.runTestProcess({ supervisor: control, name: 'vitest-crash', logRoot: resolve(root, 'logs'),
    command: process.execPath, args: [resolve(repositoryRoot, 'node_modules/vitest/vitest.mjs'), 'run', '--config', resolve(root, 'vitest.config.mjs')], cwd: root,
    env: { ...process.env, VITEST_MAX_WORKERS: '1', FIXTURE_READY: ready, FIXTURE_KILL: kill }, signal: t.signal }));
  const sibling = budget.run({ name: 'sibling', workers: 1 }, async () => { try { await closed; } finally { siblingClosed = true; } });
  const next = budget.run({ name: 'queued', workers: 1 }, async () => { queued = true; });
  let failure;
  const rejected = assert.rejects(crash, error => { failure = error; return error.result?.exitCode !== 0 && error.result?.closure.empty === true; });
  const cancelled = assert.rejects(next);
  try {
    const child = await waitJson(ready), identity = await control.reader.readIdentity({ pid: child.pid }); assert.equal(identity.status, 'FOUND');
    await writeFile(kill, 'kill'); await Promise.all([rejected, cancelled]);
    assert.equal(queued, false); assert.equal(siblingClosed, false); assert.equal(budget.summary().activeWorkers, 1);
    const observed = await waitFixtureExit(control.reader, identity.identity, t.signal);
    closeSibling(); await sibling; assert.equal(siblingClosed, true); assert.equal(budget.summary().activeWorkers, 0);
    assert.ok(failure.result.closure.empty);
    if (observed.polls > 1) t.diagnostic(JSON.stringify({ kind: 'FIXTURE_CRASH_EXIT_OBSERVATION',
      pid: child.pid, polls: observed.polls, elapsedMs: observed.elapsedMs, finalStatus: observed.status, closure: failure.result.closure }));
  } finally { await writeFile(kill, 'kill'); closeSibling(); await Promise.allSettled([crash, sibling, next]); }
});
