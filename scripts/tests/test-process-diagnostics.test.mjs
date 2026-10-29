import assert from 'node:assert/strict';
import test from 'node:test';
import { createWindowsTestJobDiagnostics } from '../../packages/process-control-node/test-process-diagnostics.mjs';

test('Job 失败诊断只读取已确认归属的成员并按根身份隔离、取出后释放', async () => {
  let nextHandle = 10;
  const imageReads = [], timeReads = [];
  const library = { func: (...declaration) => {
    const name = declaration.find(value => typeof value === 'string' && !value.includes('__stdcall'));
    return (...args) => {
      if (name === 'OpenProcess') return ++nextHandle;
      if (name === 'AssignProcessToJobObject') return 1;
      if (name === 'IsProcessInJob') { args[2][0] = args[1] === 3 ? 0 : 1; return 1; }
      if (name === 'WaitForSingleObject') return 258;
      if (name === 'GetExitCodeProcess') { args[1][0] = 259; return 1; }
      if (name === 'QueryFullProcessImageNameW') {
        imageReads.push(args[0]); args[2].write('C:\\private\\node.exe', 'utf16le'); args[3][0] = 19; return 1;
      }
      if (name === 'GetProcessTimes') { timeReads.push(args[0]); args[1].low = 123; args[1].high = 45; return 1; }
      return 1;
    };
  } };
  const native = { load: () => library, struct: value => value, pointer: value => value, out: value => value, inout: value => value };
  const diagnostics = createWindowsTestJobDiagnostics(native), kernel = native.load('kernel32.dll');
  const fn = name => kernel.func('__stdcall', name);
  const root = fn('OpenProcess')(0x1101, 0, 100);
  fn('AssignProcessToJobObject')(1, root);
  const other = fn('OpenProcess')(0x1101, 0, 200);
  fn('AssignProcessToJobObject')(2, other);
  for (const [job, pid] of [[1, 101], [2, 201], [3, 301]]) {
    const handle = fn('OpenProcess')(0x101000, 0, pid);
    fn('IsProcessInJob')(handle, job, [0]); fn('WaitForSingleObject')(handle, 0);
    fn('GetExitCodeProcess')(handle, [0]); fn('CloseHandle')(handle);
  }
  const first = diagnostics.take(100);
  assert.equal(first.length, 1); assert.equal(first[0].pid, 101); assert.equal(first[0].belongs, true);
  assert.equal(first[0].image, 'node.exe'); assert.match(first[0].created, /^\d+$/u);
  assert.equal(diagnostics.take(100).length, 0); assert.equal(diagnostics.take(200)[0].pid, 201);
  assert.equal(imageReads.length, 2); assert.equal(timeReads.length, 2);
  assert.doesNotMatch(JSON.stringify(first), /private/u);
});
