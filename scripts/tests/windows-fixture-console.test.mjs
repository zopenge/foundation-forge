import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureConsole } from '../../packages/process-control-node/tests/helpers/windows-fixture-console.mjs';

const fixture = failure => {
  const calls = [], standards = new Map([[0xfffffff6, 100n], [0xfffffff5, 101n], [0xfffffff4, 102n]]);
  let attached = false;
  const native = { load: () => ({ func: declaration => {
    const name = declaration.match(/__stdcall (\w+)/u)[1];
    return (...args) => {
      calls.push({ name, args });
      if (name === failure) return 0;
      if (name === 'AttachConsole') { attached = true; for (const key of standards.keys()) standards.set(key, 999n); return 1; }
      if (name === 'GetConsoleWindow') return attached ? 200n : null;
      if (name === 'GetStdHandle') return standards.get(args[0]);
      if (name === 'SetStdHandle') { standards.set(args[0], args[1]); return 1; }
      if (name === 'GetFileType') return 3;
      if (name === 'IsWindowVisible') return failure === 'visible' ? 1 : 0;
      return 1;
    };
  } }) };
  return { native, calls, standards };
};

test('只连接显式自有宿主，恢复AttachConsole改变的借用标准句柄且不关闭它们', async () => {
  const f = fixture();
  const value = await fixtureConsole({ ownerPid: 321, native: f.native });
  assert.deepEqual(value, { hwnd: '200', visible: false, preservedStandardHandles: true, stdoutPipe: true, stderrPipe: true });
  assert.deepEqual(f.calls.find(value => value.name === 'AttachConsole').args, [321]);
  assert.deepEqual([...f.standards.values()], [100n, 101n, 102n]);
  assert.equal(f.calls.filter(value => value.name === 'SetStdHandle').length, 3);
  assert.equal(f.calls.some(value => /FreeConsole|CloseHandle|AllocConsole|ShowWindow/u.test(value.name)), false);
});

for (const failure of ['AttachConsole', 'SetStdHandle', 'visible']) test(`连接或句柄恢复失败不得回退、伪造隐藏成功：${failure}`, async () => {
  const f = fixture(failure);
  await assert.rejects(fixtureConsole({ ownerPid: 321, native: f.native }));
  assert.equal(f.calls.filter(value => value.name === 'AttachConsole').length, 1);
  assert.equal(f.calls.some(value => /FreeConsole|AllocConsole|ShowWindow/u.test(value.name)), false);
  if (failure === 'AttachConsole') assert.equal(f.calls.some(value => value.name === 'SetStdHandle'), false);
  if (failure === 'SetStdHandle') assert.equal(f.calls.filter(value => value.name === 'SetStdHandle').length, 3);
});

for (const ownerPid of [0xffffffff, 0x100000001]) test(`保留值或超DWORD的owner在原生加载前拒绝：${ownerPid}`, async () => {
  let loaded = false;
  await assert.rejects(fixtureConsole({ ownerPid, native: { load: () => { loaded = true; throw new Error('unexpected native load'); } } }));
  assert.equal(loaded, false);
});
