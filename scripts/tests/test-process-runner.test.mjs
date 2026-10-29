import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, rmdir, writeFile, copyFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
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
    const after = await control.reader.readIdentity({ pid: child.pid }); assert.ok(after.status === 'ABSENT' || after.identity.startToken !== identity.identity.startToken);
    closeSibling(); await sibling; assert.equal(siblingClosed, true); assert.equal(budget.summary().activeWorkers, 0);
    assert.ok(failure.result.closure.empty);
  } finally { await writeFile(kill, 'kill'); closeSibling(); await Promise.allSettled([crash, sibling, next]); }
});
