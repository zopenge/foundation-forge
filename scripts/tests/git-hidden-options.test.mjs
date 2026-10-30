import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

// 执行真实私有函数的源码，只替换 OS 边界；不调用凭据管理器或创建进程。
for (const path of ['github-release.mjs', 'release-registry.mjs']) {
  test(`${path} Git 查询隐藏窗口并保留输出、输入及失败语义`, async () => {
    const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
    const start = source.indexOf('const captureGit = '), end = source.indexOf('\n};', start) + 3;
    assert.ok(start >= 0 && end > start);
    let result = { status: 0, stdout: ' value\n', stderr: '' }, captured;
    const sandbox = { spawnSync: (command, args, options) => { captured = { command, args: Array.from(args), options: { ...options } }; return result; } };
    runInNewContext(`${source.slice(start, end)}\nglobalThis.capture = captureGit;`, sandbox);
    const args = ['rev-parse', 'HEAD'];
    const call = () => sandbox.capture(args, path === 'github-release.mjs' ? { cwd: '/fixture', input: 'input' } : '/fixture');
    assert.equal(call(), 'value');
    assert.equal(captured.command, 'git'); assert.deepEqual(captured.args, args);
    assert.equal(captured.options.windowsHide, true);
    assert.equal(captured.options.cwd, '/fixture'); assert.equal(captured.options.shell, false);
    assert.equal(captured.options.encoding, 'utf8'); assert.equal(captured.options.detached, undefined);
    assert.deepEqual(Array.from(captured.options.stdio), path === 'github-release.mjs' ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe']);
    if (path === 'github-release.mjs') assert.equal(captured.options.input, 'input');
    result = { status: 7, stderr: 'git failure' }; assert.throws(call, /git failure/u);
    result = { status: null, stderr: '' }; assert.throws(call, /git rev-parse HEAD failed/u);
  });
}

test('release-status 的默认 SHA 查询隐藏窗口且保留错误', async () => {
  const source = await readFile(new URL('../release-status.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('const headSha = '), end = source.indexOf('\nlet client', start);
  assert.ok(start >= 0 && end > start);
  let result = { status: 0, stdout: 'sha\n' }, captured;
  const sandbox = { argumentsValue: {}, repositoryRoot: '/fixture', spawnSync: (command, args, options) => {
    captured = { command, args: Array.from(args), options: { ...options } }; return result;
  } };
  const evaluate = () => runInNewContext(`${source.slice(start, end)}\nheadSha;`, { ...sandbox });
  assert.equal(evaluate(), 'sha'); assert.equal(captured.command, 'git');
  assert.deepEqual(captured.args, ['rev-parse', 'HEAD']);
  assert.deepEqual(captured.options, { cwd: '/fixture', encoding: 'utf8', shell: false, windowsHide: true });
  result = { status: 7, stderr: 'git failure' }; assert.throws(evaluate, /git failure/u);
});

test('受管发布夹具的 Git SHA 查询隐藏窗口，显式 SHA 不启动 Git', async () => {
  const source = await readFile(new URL('../../packages/release-vercel/tests/helpers/managed-worker.mjs', import.meta.url), 'utf8');
  const line = source.split('\n').find(value => value.startsWith('const sha = ')); assert.ok(line);
  let calls = 0, options;
  const run = deployedSha => runInNewContext(`${line}\nsha;`, { deployedSha, cwd: '/fixture', execFileSync: (command, args, value) => {
    calls++; options = { ...value }; assert.equal(command, 'git'); assert.deepEqual(Array.from(args), ['rev-parse', 'HEAD']); return 'sha\n';
  } });
  assert.equal(run('explicit'), 'explicit'); assert.equal(calls, 0);
  assert.equal(run(undefined), 'sha'); assert.equal(calls, 1);
  assert.deepEqual(options, { cwd: '/fixture', encoding: 'utf8', windowsHide: true });
});

test('Windows脱离后代夹具隐藏实际创建边界，保留detached、stdio与unref', async () => {
  const nested = await readFile(new URL('../../packages/process-control-node/tests/owned-nested-git.test.mjs', import.meta.url), 'utf8');
  const windows = await readFile(new URL('../../packages/process-control-node/tests/owned-scope-windows.test.ts', import.meta.url), 'utf8');
  const nestedLine = nested.split('\n').find(value => value.includes('child.unref()'));
  const parentLine = windows.split('\n').find(value => value.includes('const parent = '));
  const detachLine = windows.split('\n').find(value => value.includes('const detach = '));
  for (const [line, kind] of [[nestedLine, 'nested'], [parentLine, 'parent'], [detachLine, 'detach']]) {
    assert.ok(line);
    const captured = [], child = { unref: () => captured.push('unref') };
    const process = { execPath: '/node', argv: ['node', 'fixture', '/marker'] };
    const require = name => { assert.equal(name, 'node:child_process'); return { spawn: (command, args, options) => {
      captured.push({ command, args: Array.from(args), options: { ...options } }); return child;
    } }; };
    let payload;
    if (kind === 'nested') payload = runInNewContext(`[${line.trim().replace(/^args: \[/u, '').replace(/\],$/u, '')}][1]`);
    else if (kind === 'parent') payload = runInNewContext(`${line}\nparent;`, { writer: 'writer', JSON });
    else payload = runInNewContext(`${line.replace('(body: string)', '(body)')}\ndetach('writer');`, { JSON });
    runInNewContext(payload, { require, process });
    assert.deepEqual(captured[0].options, { detached: true, stdio: 'ignore', windowsHide: true });
    assert.equal(captured[0].command, '/node'); assert.equal(captured[1], 'unref');
  }
});
