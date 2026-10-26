import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { resolve } from 'node:path';
import { setImmediate, setTimeout } from 'node:timers';
import test from 'node:test';

const module = await import('../hidden-vitest-pool.mjs').catch(error => ({ error }));
const fixture = () => {
  assert.ifError(module.error);
  const child = new EventEmitter(); child.pid = 12345; child.exitCode = null; child.signalCode = null;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const output = new PassThrough(), errors = new PassThrough(), calls = [], events = [], signals = [], failures = [];
  let stdout = '', stderr = '';
  output.on('data', value => { stdout += value; }); errors.on('data', value => { stderr += value; });
  child.send = value => { calls.push(value); };
  child.kill = signal => { signals.push(signal ?? 'SIGTERM'); return true; };
  const options = { distPath: '/vitest', execArgv: ['--conditions=node'], env: { FORGE_CHECK_JOB_ID: 'job', FORGE_CHECK_WORKER_EVENTS: 'events' },
    project: { config: { teardownTimeout: 1000 }, vitest: { state: { catchError: error => failures.push(error) }, logger: { outputStream: output, errorStream: errors } } } };
  const forks = [];
  const pool = module.createHiddenVitestPool({ forkCommand: (entry, args, value) => { forks.push({ entry, args, value }); return child; },
    record: (type, value) => { events.push({ type, ...value }); } });
  const worker = pool.createPoolWorker(options);
  return { child, options, worker, pool, forks, calls, events, signals, output, errors, failures,
    captured: () => ({ stdout, stderr }), exit: (code, signal = null) => {
      child.exitCode = code; child.signalCode = signal; child.emit('exit', code, signal);
    } };
};

test('the public custom pool hides fork consoles and preserves IPC, environment and output', async () => {
  const f = fixture(); await f.worker.start(); await f.worker.start();
  assert.equal(f.pool.name, f.worker.name); assert.notEqual(f.pool.name, 'forks'); assert.equal(f.forks.length, 1);
  const fork = f.forks[0];
  assert.equal(fork.entry, resolve('/vitest', 'workers/forks.js')); assert.deepEqual(fork.args, []);
  assert.equal(fork.value.windowsHide, true); assert.equal(fork.value.stdio, 'pipe');
  assert.equal(fork.value.serialization, 'advanced'); assert.equal(fork.value.env, f.options.env);
  assert.equal(fork.value.execArgv, f.options.execArgv); assert.equal(fork.value.detached, undefined);
  f.child.emit('spawn'); f.child.stdout.write('out'); f.child.stderr.write('err');
  const message = { __vitest_worker_request__: true, type: 'stop' }; f.worker.send(message);
  assert.deepEqual(f.calls, [message]); assert.equal(f.worker.deserialize(message), message);
  let received = 0; const listener = () => { received++; };
  f.worker.on('message', listener); f.child.emit('message', {}); f.worker.off('message', listener); f.child.emit('message', {});
  assert.equal(received, 1); assert.deepEqual(f.captured(), { stdout: 'out', stderr: 'err' });
  f.exit(0); f.child.emit('close', 0); await f.worker.stop();
  assert.deepEqual(f.events.map(value => [value.type, value.pid, value.kind]), [['start', 12345, 'vitest'], ['finish', 12345, 'vitest']]);
  assert.equal(f.output.getMaxListeners(), 10); assert.equal(f.errors.getMaxListeners(), 10);
});

test('parent-side exit finishes skipped, failed-collection and force-killed workers without child hooks', async () => {
  for (const state of ['skipped', 'collection-failed', 'SIGKILL']) {
    const f = fixture(); await f.worker.start(); f.child.emit('spawn');
    f.exit(state === 'SIGKILL' ? null : 0, state === 'SIGKILL' ? 'SIGKILL' : null);
    f.child.emit('close'); await f.worker.stop();
    assert.deepEqual(f.events.map(value => value.type), ['start', 'finish'], state);
    assert.deepEqual(f.signals, []);
  }
});

test('stop waits for real close and drains late output before releasing its worker', async () => {
  const f = fixture(); await f.worker.start(); f.child.emit('spawn');
  let stopped = false; const work = f.worker.stop().then(() => { stopped = true; });
  assert.deepEqual(f.signals, ['SIGTERM']); f.exit(0);
  await new Promise(accept => setImmediate(accept)); assert.equal(stopped, false);
  f.child.stdout.write('last output'); f.child.stderr.write('last error'); f.child.emit('close', 0); await work;
  assert.deepEqual(f.captured(), { stdout: 'last output', stderr: 'last error' });
});

test('stop escalates only its known worker after the existing 500ms termination grace', async () => {
  const f = fixture(); await f.worker.start(); f.child.emit('spawn');
  f.child.kill = signal => { f.signals.push(signal ?? 'SIGTERM'); if (signal === 'SIGKILL') { f.exit(null, signal); f.child.emit('close'); } return true; };
  await f.worker.stop();
  assert.deepEqual(f.signals, ['SIGTERM', 'SIGKILL']); assert.deepEqual(f.events.map(value => value.type), ['start', 'finish']);
});

test('failed OS startup never creates a fake worker start or finish observation', async () => {
  const f = fixture(); f.child.pid = undefined;
  await f.worker.start(); f.worker.on('error', () => {}); f.child.emit('error', new Error('spawn failed')); f.child.emit('close', -2);
  await f.worker.stop(); assert.deepEqual(f.events, []); assert.deepEqual(f.signals, []);
});

test('independent pool instances keep their actual process slot until parent exit, before pipe close', async () => {
  const f = fixture(), children = [], observations = [];
  const pool = module.createHiddenVitestPool({ workers: 1, record: type => observations.push(type), forkCommand: () => {
    const child = new EventEmitter(); Object.assign(child, { pid: 20000 + children.length, exitCode: null, signalCode: null,
      stdout: new PassThrough(), stderr: new PassThrough(), kill() { return true; } }); children.push(child); return child;
  } });
  const first = pool.createPoolWorker(f.options), second = pool.createPoolWorker(f.options);
  await first.start(); children[0].emit('spawn'); let secondStarted = false;
  const pending = second.start().then(() => { secondStarted = true; });
  try {
    await new Promise(accept => setImmediate(accept)); assert.equal(children.length, 1); assert.equal(secondStarted, false);
    const stopping = first.stop(); await new Promise(accept => setImmediate(accept)); assert.equal(children.length, 1);
    children[0].exitCode = 0; children[0].emit('exit', 0); await pending;
    assert.equal(children.length, 2); children[1].emit('spawn');
    assert.deepEqual(observations, ['start', 'finish', 'start']);
    children[0].emit('close', 0); await stopping;
    const nextStop = second.stop(); children[1].exitCode = 0; children[1].emit('exit', 0); children[1].emit('close', 0); await nextStop;
  } finally {
    for (const child of children) { child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0); }
    await Promise.allSettled([pending, first.stop(), second.stop()]);
  }
});

test('a worker crash rejects queued starts instead of releasing capacity to new files', async () => {
  const f = fixture(), children = [];
  const pool = module.createHiddenVitestPool({ workers: 1, record() {}, forkCommand: () => {
    const child = new EventEmitter(); Object.assign(child, { pid: 20000, exitCode: null, signalCode: null,
      stdout: new PassThrough(), stderr: new PassThrough(), kill() { return true; } }); children.push(child); return child;
  } });
  const first = pool.createPoolWorker(f.options), second = pool.createPoolWorker(f.options);
  await first.start(); children[0].emit('spawn');
  const pending = second.start(); const rejected = assert.rejects(pending);
  children[0].signalCode = 'SIGKILL'; children[0].emit('exit', null, 'SIGKILL'); children[0].emit('close', null, 'SIGKILL');
  await rejected; assert.equal(children.length, 1); await first.stop();
});

test('a descendant-held output pipe fails within the configured teardown deadline and releases stream handles', async () => {
  const priorExitCode = process.exitCode;
  const f = fixture(); f.options.project.config.teardownTimeout = 25;
  await f.worker.start(); f.child.emit('spawn'); f.exit(0);
  try {
    const outcome = await Promise.race([f.worker.stop().then(() => 'resolved', error => error.message),
      new Promise(accept => { setTimeout(() => accept('unbounded'), 100); })]);
    assert.match(outcome, /output did not close/u);
    assert.equal(f.child.stdout.destroyed, true); assert.equal(f.child.stderr.destroyed, true);
    assert.equal(f.failures.length, 1); assert.equal(process.exitCode, 1);
  } finally { f.child.emit('close', 0); process.exitCode = priorExitCode; }
});
