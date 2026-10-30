import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { capturePnpmOutput } from '../workspace-packages.mjs';
import { runCapturedSync } from '../package-consumer-runner.mjs';

test('config-bundle真实消费者的浏览器条件子进程隐藏窗口并保留验证代码和捕获语义', async () => {
  const source = await readFile(new URL('../../packages/config-bundle/package-consumer/verify.mjs', import.meta.url), 'utf8');
  const start = source.lastIndexOf('execFileSync(execPath,'); assert.ok(start >= 0);
  const code = source.slice(start).replace('import.meta.dirname', 'fixtureRoot'); let captured;
  const run = execute => runInNewContext(code, { execPath: 'node.exe', fixtureRoot: '/owned/consumer', execFileSync: execute });
  run((command, args, options) => { captured = { command, args: Array.from(args), options: { ...options } }; });
  assert.equal(captured.command, 'node.exe');
  assert.deepEqual(captured.args.slice(0, 3), ['--conditions=browser', '--input-type=module', '-e']);
  assert.match(captured.args[3], /createConfigBundle/u); assert.match(captured.args[3], /ERR_PACKAGE_PATH_NOT_EXPORTED/u);
  assert.deepEqual(captured.options, { cwd: '/owned/consumer', stdio: 'pipe', windowsHide: true });
  const failure = new Error('browser verifier failed'); assert.throws(() => run(() => { throw failure; }), error => error === failure);
});

test('source-snapshot真实Git夹具隐藏进程并保留参数、输出和失败', async () => {
  const source = await readFile(new URL('../../packages/source-snapshot/tests/node-fixtures.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export const runGit = '), end = source.indexOf('\n};', start) + 3;
  assert.ok(start >= 0 && end > start);
  const code = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace('export const ', 'const ');
  let captured;
  const execute = async (command, args, options) => { captured = { command, args: Array.from(args), options: { ...options } }; return { stdout: 'git-output\n' }; };
  const run = exec => runInNewContext(`${code}\nrunGit;`, { exec });
  assert.equal(await run(execute)('/owned/fixture', ['status']), 'git-output\n');
  assert.equal(captured.command, 'git');
  assert.deepEqual(captured.args, ['--no-optional-locks', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.quotepath=false', '-C', '/owned/fixture', 'status']);
  assert.deepEqual(captured.options, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  const failure = new Error('git failed'); await assert.rejects(run(async () => { throw failure; })('/owned/fixture', []), error => error === failure);
});

test('发布Git捕获隐藏进程，保留独立输出、退出码和启动失败', async () => {
  const source = await readFile(new URL('../publish-if-needed.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('  function capture(command, args) {'), end = source.indexOf('\n  }', start) + 4;
  assert.ok(start >= 0 && end > start);
  let captured, startupFailure;
  const capture = runInNewContext(`${source.slice(start, end)}\ncapture;`, { repositoryRoot: '/owned/repository', spawn: (command, args, options) => {
    captured = { command, args: Array.from(args), options: { ...options } };
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    globalThis.queueMicrotask(() => {
      if (startupFailure) child.emit('error', startupFailure);
      else { child.stdout.end('out'); child.stderr.end('err'); child.emit('exit', 7); }
    });
    return child;
  } });
  assert.deepEqual(JSON.parse(JSON.stringify(await capture('git', ['rev-parse', 'HEAD']))), { code: 7, stderr: 'err', stdout: 'out' });
  assert.equal(captured.command, 'git'); assert.deepEqual(captured.args, ['rev-parse', 'HEAD']);
  assert.deepEqual(JSON.parse(JSON.stringify(captured.options)), { cwd: '/owned/repository', shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  startupFailure = new Error('git startup failed'); await assert.rejects(capture('git', []), error => error === startupFailure);
});

test('消费者启动跟踪仅在显式诊断时保存阶段及PID，不泄露输出或参数', async () => {
  const source = await readFile(new URL('../../packages/command-runner/package-consumer/verify.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('const traceCommand = '), end = source.indexOf('\n};', start) + 3;
  assert.ok(start >= 0 && end > start);
  const rows = [], process = { pid: 10, env: {}, stdout: { write: value => rows.push(JSON.parse(value)) } };
  const trace = runInNewContext(`${source.slice(start, end)}\ntraceCommand;`, { process });
  trace('output')({ type: 'spawned', pid: 20 }); assert.equal(rows.length, 0);
  process.env.FORGE_PROCESS_TIMELINE = '1';
  trace('output')({ type: 'stdout', chunk: 'private-output' }); assert.equal(rows.length, 0);
  trace('output')({ type: 'spawned', pid: 20, args: ['private-argument'] });
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['at', 'callsite', 'childPid', 'phase', 'pid']);
  assert.equal(rows[0].phase, 'output'); assert.equal(rows[0].pid, 10); assert.equal(rows[0].childPid, 20);
  assert.equal(rows[0].callsite, 'command-runner/package-consumer/verify.mjs'); assert.ok(Number.isFinite(Date.parse(rows[0].at)));
  assert.doesNotMatch(JSON.stringify(rows), /private-output|private-argument/u);
});

test('真实command-runner消费者的detached孙进程隐藏窗口并保留分离及unref语义', async () => {
  const source = await readFile(new URL('../../packages/command-runner/package-consumer/verify.mjs', import.meta.url), 'utf8');
  const line = source.split('\n').find(value => value.startsWith('const detach = ')); assert.ok(line);
  const code = runInNewContext(`${line}\ndetach;`);
  let captured, unreferenced = 0;
  const spawn = (command, args, options) => {
    captured = { command, args: Array.from(args), options: { ...options } };
    return { unref() { unreferenced++; } };
  };
  const run = spawnCommand => runInNewContext(code, { process: { execPath: 'node.exe' }, require: name => {
    assert.equal(name, 'node:child_process'); return { spawn: spawnCommand };
  } });
  run(spawn);
  assert.equal(captured.command, 'node.exe');
  assert.deepEqual(captured.args, ['-e', 'setInterval(()=>{},1000)']);
  assert.deepEqual(captured.options, { detached: true, windowsHide: true, stdio: 'ignore' });
  assert.equal(unreferenced, 1);
  const failure = new Error('spawn failed');
  assert.throws(() => run(() => { throw failure; }), error => error === failure);
});

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
