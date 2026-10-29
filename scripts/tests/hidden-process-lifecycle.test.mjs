import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { capturePnpmOutput, discoverWorkspacePackageModel } from '../workspace-packages.mjs';
import { runCapturedSync } from '../package-consumer-runner.mjs';
import { discoverTestProcessSupervisor, runTestProcess } from '../test-process-runner.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');
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
  let identity;
  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try { identity = JSON.parse(await readFile(marker, 'utf8')); break; }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      await delay(10);
    }
    assert.ok(identity);
  } finally { controller.abort(); await closed; }
  assert.equal((await supervisor.reader.readIdentity({ pid: identity.pid })).status, 'ABSENT');
  assert.equal(await readFile(resolve(root, 'cancel/stdout.log'), 'utf8'), 'ready-output');
  assert.equal(await readFile(resolve(root, 'cancel/stderr.log'), 'utf8'), 'ready-error');
  const proof = JSON.parse(await readFile(resolve(root, 'cancel/process.json'), 'utf8'));
  process.stdout.write(`${JSON.stringify({ cancellation: proof, descendantPid: identity.pid, descendantStatus: 'ABSENT' })}\n`);
  assert.equal(proof.closure.empty, true); assert.equal(proof.closure.status, 'unknown');
});
