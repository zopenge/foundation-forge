import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { capturePnpmOutput } from '../workspace-packages.mjs';
import { runCapturedSync } from '../package-consumer-runner.mjs';

test('workspace discovery hides its console while keeping separate output pipes', async () => {
  let options;
  const spawnCommand = (_command, _args, value) => {
    options = value;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    globalThis.queueMicrotask(() => { child.stdout.write('[{"name":"example"}]'); child.emit('exit', 0); });
    return child;
  };
  assert.equal(await capturePnpmOutput('/workspace', { spawnCommand }), '[{"name":"example"}]');
  assert.equal(options.windowsHide, true);
  assert.equal(options.cwd, '/workspace');
  assert.equal(options.shell, false);
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(options.detached, undefined);
});

test('workspace discovery still rejects child failures with stderr', async () => {
  const spawnCommand = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    globalThis.queueMicrotask(() => { child.stderr.write('metadata failed'); child.emit('exit', 7); });
    return child;
  };
  await assert.rejects(capturePnpmOutput('/workspace', { spawnCommand }), /metadata failed/u);
});

test('synchronous consumer commands hide their console without changing capture or environment', () => {
  const env = { EXAMPLE: 'retained' };
  let options;
  const spawnCommand = (command, args, value) => {
    assert.equal(command, 'example'); assert.deepEqual(args, ['argument']); options = value;
    return { status: 0, stdout: ' captured output\n', stderr: '' };
  };
  assert.equal(runCapturedSync('example', ['argument'], { cwd: '/workspace', env, spawnCommand }), 'captured output');
  assert.equal(options.windowsHide, true); assert.equal(options.shell, false);
  assert.equal(options.cwd, '/workspace'); assert.equal(options.env, env);
  assert.equal(options.encoding, 'utf8'); assert.equal(options.maxBuffer, 16 * 1_024 * 1_024);
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(options.detached, undefined);
});

test('synchronous consumer command failures retain status, stdout and stderr', () => {
  assert.throws(() => runCapturedSync('example', [], {
    spawnCommand: () => ({ status: 7, stdout: 'before failure', stderr: 'failure detail' }),
  }), /status 7\nbefore failure\nfailure detail/u);
});

const releaseCliProbe = async spawnSync => {
  const source = await readFile(new URL('../../packages/release-vercel/package-consumer/verify.mjs', import.meta.url), 'utf8');
  const end = source.indexOf('const report = await runRelease');
  assert.ok(end > 0);
  runInNewContext(source.slice(0, end).replace(/^import .*;$/gmu, ''), {
    spawnSync, releaseErrorCodes: ['CANDIDATE_CHANGED'], runRelease() {},
    validateReleaseConfig: () => { throw Object.assign(new Error('invalid config'), { code: 'CONFIG_INVALID' }); },
    process: { execPath: '/node', env: { PACKAGE_CONSUMER_BINARIES: '{"forge-vercel-release":"/consumer/release.mjs"}' } },
  });
};

test('release consumer CLI probe hides its window and preserves its captured argument error', async () => {
  let captured;
  await releaseCliProbe((command, args, options) => {
    captured = { command, args: Array.from(args), options: { ...options } };
    return { status: 2, stdout: '{"error":{"code":"ARGUMENT_INVALID"}}', stderr: '' };
  });
  assert.equal(captured.command, '/node');
  assert.deepEqual(captured.args, ['/consumer/release.mjs', 'publish', '--sha', 'bad']);
  assert.deepEqual(captured.options, { encoding: 'utf8', shell: false, windowsHide: true });
});

test('release consumer CLI probe still rejects wrong exits, contract errors and cancellation', async t => {
  for (const [name, result] of [
    ['exit', { status: 1, stdout: '{"error":{"code":"ARGUMENT_INVALID"}}' }],
    ['contract', { status: 2, stdout: '{"error":{"code":"OTHER"}}' }],
    ['cancelled', { status: null, signal: 'SIGTERM', stdout: '' }],
  ]) await t.test(name, async () => {
    await assert.rejects(releaseCliProbe(() => result), /release CLI consumer contract failed/u);
  });
});

test('detached writer fixtures hide their child windows while keeping detachment and parent exit behavior', async () => {
  const source = await readFile(new URL('../../packages/release-vercel/tests/managed-process.test.ts', import.meta.url), 'utf8');
  const programs = [...source.matchAll(/const parent = (`[^`]+`);/gu)];
  assert.equal(programs.length, 2);
  const expectedArguments = [['-e', 'writer-source', 'marker'], ['-e', 'writer-source', 'marker', 'output']];
  const expectedTimers = [[2500], []];
  for (const [index, match] of programs.entries()) {
    const program = runInNewContext(`(${match[1]})`, { writer: 'writer-source' });
    const calls = [], timers = []; let unrefs = 0;
    runInNewContext(program, {
      process: { execPath: '/node', argv: ['parent', 'marker', 'output'], exit() { throw new Error('parent exited during injection'); } },
      require: name => {
        assert.equal(name, 'node:child_process');
        return { spawn: (command, args, options) => {
          calls.push({ command, args: Array.from(args), options: { ...options } });
          return { unref() { unrefs++; } };
        } };
      },
      setTimeout: (_callback, milliseconds) => { timers.push(milliseconds); },
    });
    assert.equal(calls.length, 1); assert.equal(calls[0].command, '/node');
    assert.deepEqual(calls[0].args, expectedArguments[index]);
    assert.deepEqual(calls[0].options, { stdio: 'ignore', detached: true, windowsHide: true });
    assert.equal(unrefs, 1); assert.deepEqual(timers, expectedTimers[index]);
  }
});
