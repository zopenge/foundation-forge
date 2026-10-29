import assert from 'node:assert/strict';
import test from 'node:test';
import { runWindowsFixtureHost } from '../../packages/process-control-node/tests/helpers/windows-fixture-host.mjs';

const fixture = (failure) => {
  const calls = [];
  const native = { struct: value => value, pointer: value => value, out: value => value,
    sizeof: value => value?.desktop !== undefined ? 104 : 24,
    load: () => ({ func: (...declaration) => {
      const name = declaration.find(value => typeof value === 'string' && value !== '__stdcall');
      return (...args) => {
        calls.push({ name, args });
        if (name === 'GetLastError') return 5;
        if (name === failure) return 0;
        if (name === 'CreateProcessW') { Object.assign(args[9], { process: 201n, thread: 202n, pid: 100, tid: 101 }); return 1; }
        if (name === 'ResumeThread') return failure === 'resume' ? 0xffffffff : 1;
        if (name === 'WaitForSingleObject') return failure === 'wait' ? 0xffffffff : failure === 'timeout' && args[1] === 0 ? 258 : 0;
        if (name === 'GetExitCodeProcess') { args[1][0] = failure === 'exit' ? 7 : 0; return 1; }
        return 1;
      };
    } }) };
  const backend = Object.fromEntries(['attach', 'empty', 'force', 'dispose'].map(name => [name, async (...args) => {
    calls.push({ name: `job.${name}`, args });
    if (failure === name) throw new Error(`job.${name}`);
    if (name === 'empty') return failure !== 'not-empty' || calls.some(value => value.name === 'job.force');
  }]));
  return { native, calls, createBackend: async () => backend };
};
const request = { executable: 'C:\\Program Files\\node.exe', args: ['E:\\repo with spaces\\host.mjs', 'E:\\repo\\request.json'], cwd: 'E:\\repo', timeoutMs: 1000 };

test('私有宿主隐藏且暂停加入Job后才恢复，不继承句柄或切换调用者桌面', async () => {
  const f = fixture(); const result = await runWindowsFixtureHost({ ...request, ...f });
  const started = f.calls.find(value => value.name === 'CreateProcessW');
  assert.equal(started.args[8].desktop, null); assert.equal(started.args[4], 0);
  assert.equal(started.args[5], 0x14); assert.equal(started.args[0], request.executable);
  assert.equal(started.args[8].flags, 1); assert.equal(started.args[8].show, 0);
  assert.equal(started.args[1].toString('utf16le').replace(/\0$/u, ''), '"C:\\Program Files\\node.exe" "E:\\repo with spaces\\host.mjs" "E:\\repo\\request.json"');
  assert.equal(result.pid, 100); assert.equal(result.exitCode, 0); assert.equal(result.empty, true);
  const names = f.calls.map(value => value.name);
  assert.ok(names.indexOf('CreateProcessW') < names.indexOf('job.attach'));
  assert.ok(names.indexOf('job.attach') < names.indexOf('ResumeThread'));
  assert.ok(names.indexOf('job.empty') < names.indexOf('job.dispose'));
  assert.deepEqual(f.calls.find(value => value.name === 'job.attach').args, [100]);
  assert.equal(f.calls.find(value => value.name === 'job.empty').args[0], true);
  assert.equal(names.includes('job.force'), false);
  assert.deepEqual(f.calls.filter(value => value.name === 'CloseHandle').map(value => value.args[0]), [202n, 201n]);
  assert.equal(f.calls.at(-1).name, 'job.dispose');
  assert.equal(f.calls.some(value => /Desktop|WindowStation/u.test(value.name)), false);
});

for (const mode of ['CreateProcessW', 'wait', 'exit']) test(`私有宿主失败不回退普通启动并传播失败：${mode}`, async () => {
  const f = fixture(mode);
  await assert.rejects(runWindowsFixtureHost({ ...request, ...f }));
  assert.equal(f.calls.filter(value => value.name === 'CreateProcessW').length, 1);
  assert.equal(f.calls.at(-1).name, 'job.dispose');
});

for (const mode of ['attach', 'resume', 'timeout', 'not-empty', 'empty', 'dispose', 'CloseHandle']) test(`自有Job在失败后强制收尾且仍释放其他句柄：${mode}`, async () => {
  const f = fixture(mode);
  await assert.rejects(runWindowsFixtureHost({ ...request, timeoutMs: 1, ...f }));
  const names = f.calls.map(value => value.name);
  if (mode === 'attach') {
    assert.equal(names.includes('ResumeThread'), false);
    assert.equal(names.includes('TerminateProcess'), true);
  }
  if (!['dispose', 'CloseHandle'].includes(mode)) assert.equal(names.includes('job.force'), true);
  assert.equal(names.includes('job.dispose'), true);
  assert.equal(f.calls.filter(value => value.name === 'CloseHandle').length, 2);
  assert.equal(names.at(-1), 'job.dispose');
});
