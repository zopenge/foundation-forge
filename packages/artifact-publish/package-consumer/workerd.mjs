import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { process, URL, setTimeout, clearTimeout, fetch, AbortSignal } = globalThis;

const tooling = createRequire(join(process.env.PACKAGE_CONSUMER_TOOLING_ROOT, 'package.json'));
const { build, stop: stopBuild } = tooling('esbuild');
const { default: binary, version } = tooling('workerd');

async function start(root, onCreated) {
  const child = spawn(binary, ['serve', '--experimental', '--control-fd=1', 'config.capnp'], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostic = '', control = '', timer, didClose = false, stopping;
  const closed = new Promise(resolveClosed => child.once('close', (code, signal) => {
    didClose = true; resolveClosed({ code, signal });
  }));
  const ready = new Promise((accept, reject) => {
    child.once('error', reject);
    child.stderr.on('data', bytes => { diagnostic += bytes; if (diagnostic.length > 65_536) reject(Error('workerd diagnostic bound')); });
    child.stdout.on('data', bytes => {
      control += bytes;
      if (control.length > 65_536) return reject(Error('workerd control bound'));
      for (;;) {
        const end = control.indexOf('\n'); if (end < 0) break;
        const line = control.slice(0, end); control = control.slice(end + 1);
        try {
          const event = JSON.parse(line);
          if (event.event === 'listen' && event.socket === 'http' && Number.isInteger(event.port) && event.port > 0)
            accept('http://127.0.0.1:' + event.port);
        } catch (error) { reject(error); }
      }
    });
    closed.then(result => reject(Error('workerd closed before readiness: ' + JSON.stringify(result) + diagnostic)));
    timer = setTimeout(() => reject(Error('workerd startup deadline: ' + diagnostic)), 30_000);
  });
  const stop = () => stopping ??= (async () => {
    if (!didClose) child.kill('SIGTERM');
    let deadline;
    try {
      await Promise.race([closed, new Promise((_, reject) => {
        deadline = setTimeout(() => reject(Error('workerd close deadline: ' + diagnostic)), 10_000);
      })]);
    } finally { clearTimeout(deadline); }
  })();
  let endpoint;
  const runtime = { stop, get closed() { return didClose; }, async call(path, id = 'normal') {
    const response = await fetch(endpoint + path + '?id=' + id, { signal: AbortSignal.timeout(15_000) });
    assert.equal(response.status, 200, diagnostic);
    return response.json();
  } };
  onCreated(runtime);
  try {
    endpoint = await ready;
    return runtime;
  } catch (error) {
    try { await stop(); } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'workerd startup and cleanup failed', { cause: cleanup });
    }
    throw error;
  } finally { clearTimeout(timer); }
}

export async function verifyWorkerd() {
  const root = await mkdtemp(join(process.cwd(), 'wd-'));
  let runtime, failure;
  try {
    const result = await build({ stdin: {
      contents: await readFile(new URL('./worker-entry.mjs', import.meta.url), 'utf8'),
      resolveDir: process.env.PACKAGE_CONSUMER_ROOT, sourcefile: 'worker-entry.mjs',
    }, absWorkingDir: process.env.PACKAGE_CONSUMER_ROOT, bundle: true, platform: 'browser', format: 'esm',
    write: false, metafile: true, external: ['cloudflare:workers'] });
    // 构建工具可来自源码 devDependencies；被测代码必须只来自独立 tarball 消费目录。
    for (const input of Object.keys(result.metafile.inputs).filter(path => path !== 'worker-entry.mjs')) {
      const path = relative(process.env.PACKAGE_CONSUMER_ROOT, resolve(process.env.PACKAGE_CONSUMER_ROOT, input));
      assert.ok(!isAbsolute(path) && path !== '..' && !path.startsWith('../') && !path.startsWith('..\\'), input);
    }
    assert.equal(Object.values(result.metafile.outputs).flatMap(value => value.imports)
      .some(value => value.path.startsWith('node:')), false);
    await writeFile(join(root, 'worker.mjs'), result.outputFiles[0].text);
    await copyFile(fileURLToPath(new URL('./worker-config.capnp', import.meta.url)), join(root, 'config.capnp'));
    await mkdir(join(root, 'data'));
    runtime = await start(root, value => { runtime = value; });
    const first = await runtime.call('/perform');
    assert.equal(first.receipt.outcome, 'pending'); assert.equal(first.receipt.record.schemaVersion, 2);
    assert.equal(first.effects, 1); assert.equal(first.observations, 1);
    assert.deepEqual(first.nodeGlobals, ['undefined', 'undefined']);
    assert.deepEqual(first.receipt.closure, { status: 'closed', activeRequests: 0 });
    await runtime.stop(); runtime = undefined;
    // 重启真实进程后恢复本 fixture 的 SQLite journal，不能依赖 JS 内存状态。
    runtime = await start(root, value => { runtime = value; });
    const second = await runtime.call('/observe');
    assert.equal(second.receipt.outcome, 'pending'); assert.equal(second.observations, 2); assert.equal(second.effects, 1);
    assert.equal(second.receipt.record.binding.fingerprint, first.receipt.record.binding.fingerprint);
    const third = await runtime.call('/observe');
    assert.equal(third.receipt.outcome, 'succeeded'); assert.equal(third.observations, 3); assert.equal(third.effects, 1);
    assert.equal(third.receipt.record.reference, first.receipt.record.reference);
    assert.equal((await runtime.call('/perform')).code, 'RECOVERY_REQUIRED');
    assert.equal((await runtime.call('/observe', 'missing')).code, 'OPERATION_MISSING');
    const lost = await runtime.call('/lost-claim', 'lost');
    assert.equal(lost.code, 'JOURNAL_UNKNOWN'); assert.equal(lost.effects, 0); assert.equal(lost.receipt.journalState, 'unknown');
    const recovered = await runtime.call('/observe', 'lost');
    assert.equal(recovered.effects, 0); assert.equal(recovered.receipt.outcome, 'unknown');
    const race = await Promise.all([runtime.call('/perform', 'race'), runtime.call('/perform', 'race')]);
    assert.equal(race.filter(value => value.receipt?.outcome === 'pending').length, 1);
    assert.ok(race.some(value => ['JOURNAL_CONFLICT', 'RECOVERY_REQUIRED'].includes(value.code)));
    assert.equal((await runtime.call('/stats', 'race')).effects, 1);
    const legacy = await runtime.call('/legacy', 'legacy');
    assert.equal(legacy.code, 'INVALID_JOURNAL'); assert.equal(legacy.effects, 0); assert.equal(legacy.observations, 0);
    const unconfirmed = await runtime.call('/unconfirmed', 'close');
    assert.equal(unconfirmed.code, 'CLOSURE_UNCONFIRMED'); assert.equal(unconfirmed.receipt.outcome, 'unknown');
    const cancelled = await runtime.call('/cancel', 'cancel');
    assert.equal(cancelled.code, 'OPERATION_ABORTED'); assert.equal(cancelled.effects, 0);
    process.stdout.write(`Real workerd ${version}: tarball, SQLite restart, pending recovery, CAS and closure verified.\n`);
  } catch (error) { failure = error; }
  const errors = failure ? [failure] : [];
  try { await runtime?.stop(); } catch (error) { errors.push(error); }
  stopBuild();
  if (!runtime || runtime.closed) {
    try { await rm(root, { recursive: true, force: true }); } catch (error) { errors.push(error); }
  } else errors.push(Error('workerd still owns fixture: ' + root));
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, 'workerd verification and cleanup failed', { cause: failure });
}
