import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { capturePnpmOutput, discoverWorkspacePackageModel } from '../workspace-packages.mjs';
import { runCapturedSync } from '../package-consumer-runner.mjs';
import { discoverTestProcessSupervisor, runTestProcess } from '../test-process-runner.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const waitForDescendantAbsent = async (reader, identity, { deadline, now = () => performance.now(), pause = delay, signal } = {}) => {
  for (;;) {
    signal?.throwIfAborted();
    const remaining = deadline - now();
    assert.ok(remaining > 0, `DESCENDANT_ABSENCE_DEADLINE ${JSON.stringify(identity)}`);
    const result = await reader.readIdentity({ pid: identity.pid,
      signal: signal ? globalThis.AbortSignal.any([signal, globalThis.AbortSignal.timeout(Math.ceil(remaining))]) : globalThis.AbortSignal.timeout(Math.ceil(remaining)) });
    signal?.throwIfAborted();
    assert.ok(now() < deadline, `DESCENDANT_ABSENCE_DEADLINE ${JSON.stringify({ identity, result })}`);
    if (result.status === 'ABSENT') return result;
    assert.ok(result.status === 'FOUND' && result.identity.pid === identity.pid && result.identity.startToken === identity.startToken,
      `DESCENDANT_IDENTITY_CHANGED ${JSON.stringify({ identity, result })}`);
    await pause(Math.min(10, deadline - now()), undefined, { signal });
  }
};

test('descendant absence waits for the same instance to become absent', async () => {
  const identity = { pid: 42, startToken: 'original' }, values = [
    { status: 'FOUND', identity }, { status: 'FOUND', identity }, { status: 'ABSENT' },
  ];
  let clock = 0, reads = 0;
  const result = await waitForDescendantAbsent({ readIdentity: async () => { reads++; return values.shift(); } }, identity,
    { deadline: 100, now: () => clock, pause: async milliseconds => { clock += milliseconds; } });
  assert.equal(result.status, 'ABSENT'); assert.equal(reads, 3); assert.equal(clock, 20);
});
test('descendant absence uses only the remainder of the original cleanup budget', async () => {
  const identity = { pid: 42, startToken: 'original' }; let clock = 9_998, reads = 0;
  await assert.rejects(waitForDescendantAbsent({ readIdentity: async () => { reads++; return { status: 'FOUND', identity }; } }, identity,
    { deadline: 10_000, now: () => clock, pause: async milliseconds => { clock += milliseconds; } }), /DESCENDANT_ABSENCE_DEADLINE/u);
  assert.equal(clock, 10_000); assert.equal(reads, 1);
});
test('descendant absence rejects PID reuse immediately instead of reporting absence', async () => {
  let reads = 0;
  await assert.rejects(waitForDescendantAbsent({ readIdentity: async () => {
    reads++; return { status: 'FOUND', identity: { pid: 42, startToken: 'replacement' } };
  } }, { pid: 42, startToken: 'original' }, { deadline: 100, now: () => 0,
    pause: async () => assert.fail('identity change must not wait') }), /DESCENDANT_IDENTITY_CHANGED/u);
  assert.equal(reads, 1);
});
test('descendant absence preserves query failure without retry', async () => {
  const failure = new Error('native query failure'); let reads = 0;
  await assert.rejects(waitForDescendantAbsent({ readIdentity: async () => { reads++; throw failure; } }, { pid: 42, startToken: 'original' },
    { deadline: 100, now: () => 0 }), error => error === failure);
  assert.equal(reads, 1);
});
test('descendant absence rejects a late successful result and a pre-cancelled read', async () => {
  let clock = 0;
  await assert.rejects(waitForDescendantAbsent({ readIdentity: async () => { clock = 101; return { status: 'ABSENT' }; } },
    { pid: 42, startToken: 'original' }, { deadline: 100, now: () => clock }), /DESCENDANT_ABSENCE_DEADLINE/u);
  const reason = new Error('cancelled');
  await assert.rejects(waitForDescendantAbsent({ readIdentity: async () => assert.fail('cancelled query must not start') },
    { pid: 42, startToken: 'original' }, { deadline: 100, now: () => 0, signal: globalThis.AbortSignal.abort(reason) }), error => error === reason);
});
const consoleProbe = `
  const koffi = require('koffi');
  const handle = koffi.load('kernel32.dll').func('void * __stdcall GetConsoleWindow()')();
  const visible = Boolean(handle && koffi.load('user32.dll').func('int __stdcall IsWindowVisible(void *)')(handle));
  console.log(JSON.stringify({ pid: process.pid, visible }));
`;

test('hidden metadata and synchronous commands preserve real output and nonzero exits', () => {
  assert.equal(runCapturedSync(process.execPath, ['-e', 'console.log("captured")']), 'captured');
  assert.throws(() => runCapturedSync(process.execPath, ['-e', 'console.log("out");console.error("err");process.exitCode=7']), /status 7\nout\r?\n\nerr/u);
});

test('hidden workspace discovery returns real package metadata', { timeout: 15_000 }, async () => {
  const listing = JSON.parse(await capturePnpmOutput(repositoryRoot));
  assert.ok(listing.length > 1);
  assert.ok(listing.every(value => typeof value.path === 'string'));
});

test('hidden native supervision captures output, cancels and closes its own descendant', { timeout: 30_000 }, async t => {
  const base = resolve(repositoryRoot, '.tmp/tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(resolve(base, 'hidden-lifecycle-'));
  t.after(async () => {
    const child = relative(base, root); assert.ok(child && !child.startsWith('..') && !isAbsolute(child));
    await rm(root, { recursive: true, force: true });
  });
  const model = await discoverWorkspacePackageModel({ repositoryRoot });
  const supervisor = await discoverTestProcessSupervisor({ packages: model.packages });
  const adapter = model.packages.find(value => value.manifest.dependencies?.koffi);
  assert.ok(adapter);
  if (process.platform === 'win32') {
    const output = JSON.parse(runCapturedSync(process.execPath, ['-e', consoleProbe], { cwd: adapter.packageRoot }));
    assert.equal(output.visible, false);
    await runTestProcess({ supervisor, name: 'hidden-visibility', logRoot: resolve(root, 'visibility'), command: process.execPath,
      args: ['-e', consoleProbe], cwd: adapter.packageRoot, signal: t.signal });
    const supervised = JSON.parse(await readFile(resolve(root, 'visibility/stdout.log'), 'utf8'));
    assert.equal(supervised.visible, false);
    process.stdout.write(`${JSON.stringify({ synchronous: output, supervised })}\n`);
  }
  const marker = resolve(root, 'ready.json');
  const childCode = 'require("node:fs").writeFileSync(process.argv[1],JSON.stringify({pid:process.pid}));setInterval(()=>{},100)';
  const parentCode = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)},process.argv[1]],{windowsHide:true,detached:true,stdio:'ignore'});process.stdout.write('ready-output');process.stderr.write('ready-error');setInterval(()=>{},100)`;
  const controller = new globalThis.AbortController();
  const task = runTestProcess({ supervisor, name: 'hidden-cancel', logRoot: resolve(root, 'cancel'), command: process.execPath,
    args: ['-e', parentCode, marker], cwd: root, signal: controller.signal });
  const closed = assert.rejects(task, error => error.result?.closure.empty === true);
  let identity, descendantIdentity, cleanupDeadline;
  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try { identity = JSON.parse(await readFile(marker, 'utf8')); break; }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      await delay(10);
    }
    assert.ok(identity);
    const before = await supervisor.reader.readIdentity({ pid: identity.pid, signal: t.signal });
    assert.equal(before.status, 'FOUND'); descendantIdentity = before.identity;
  } finally { cleanupDeadline = performance.now() + 10_000; controller.abort(); await closed; }
  const proof = JSON.parse(await readFile(resolve(root, 'cancel/process.json'), 'utf8'));
  process.stdout.write(`${JSON.stringify({ cancellation: proof, descendantIdentity })}\n`);
  // Job退出码与进程对象完成信号可能先后到达；只等待同一实例，沿用取消前建立的总收尾截止点。
  const descendant = await waitForDescendantAbsent(supervisor.reader, descendantIdentity, { deadline: cleanupDeadline, signal: t.signal });
  process.stdout.write(`${JSON.stringify({ cancellation: proof, descendantPid: identity.pid, descendant })}\n`);
  assert.equal(descendant.status, 'ABSENT');
  assert.equal(await readFile(resolve(root, 'cancel/stdout.log'), 'utf8'), 'ready-output');
  assert.equal(await readFile(resolve(root, 'cancel/stderr.log'), 'utf8'), 'ready-error');
  process.stdout.write(`${JSON.stringify({ cancellation: proof, descendantPid: identity.pid, descendantStatus: 'ABSENT' })}\n`);
  assert.equal(proof.closure.empty, true); assert.equal(proof.closure.status, 'unknown');
});
