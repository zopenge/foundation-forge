import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createWindowsTestJobDiagnostics } from '../../packages/process-control-node/test-process-diagnostics.mjs';
import { wrapWindowsJobBackend } from '../../packages/process-control-node/tests/helpers/windows-job-backend-observer.mjs';

test('Job 失败诊断只读取已确认归属的成员并按根身份隔离、取出后释放', async () => {
  let nextHandle = 10;
  const imageReads = [], timeReads = [], parentReads = [], identities = new Map();
  const library = { func: (...declaration) => {
    const name = declaration.find(value => typeof value === 'string' && !value.includes('__stdcall'));
    return (...args) => {
      if (name === 'OpenProcess') { const handle = ++nextHandle; identities.set(handle, args[2]); return handle; }
      if (name === 'AssignProcessToJobObject') return 1;
      if (name === 'IsProcessInJob') { args[2][0] = args[1] === 3 ? 0 : 1; return 1; }
      if (name === 'WaitForSingleObject') return 258;
      if (name === 'GetExitCodeProcess') { args[1][0] = 259; return 1; }
      if (name === 'QueryFullProcessImageNameW') {
        imageReads.push(args[0]); args[2].write('C:\\private\\node.exe', 'utf16le'); args[3][0] = 19; return 1;
      }
      if (name === 'GetProcessTimes') { timeReads.push(args[0]); args[1].low = 123; args[1].high = 45; return 1; }
      if (name === 'NtQueryInformationProcess') {
        parentReads.push(args[0]); args[2].uniqueProcessId = identities.get(args[0]);
        args[2].parentProcessId = identities.get(args[0]) - 1; args[4][0] = 48; return 0;
      }
      return 1;
    };
  } };
  const native = { load: () => library, struct: value => value, pointer: value => value, out: value => value, inout: value => value,
    sizeof: value => typeof value === 'string' ? 8 : 48, offsetof: (_type, field) => field === 'uniqueProcessId' ? 32 : 40 };
  const diagnostics = createWindowsTestJobDiagnostics(native), kernel = native.load('kernel32.dll');
  const events = [], unsubscribe = diagnostics.observeJobs(event => events.push(event));
  const fn = name => kernel.func('__stdcall', name);
  const jobCreatedAt = Date.now(); fn('CreateJobObjectW')(null, null);
  const lateEvents = [], stopLate = diagnostics.observeJobs(event => lateEvents.push(event));
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
  assert.equal(first[0].parentPid, 100);
  assert.equal(diagnostics.take(100).length, 0); assert.equal(diagnostics.take(200)[0].pid, 201);
  assert.equal(imageReads.length, 2); assert.equal(timeReads.length, 2); assert.equal(parentReads.length, 2);
  assert.doesNotMatch(JSON.stringify(first), /private/u);
  fn('CloseHandle')(1);
  assert.deepEqual(events.map(value => value.type), ['assigned', 'assigned', 'closing']);
  assert.equal(events[0].rootPid, 100); assert.equal(events[0].job, 1);
  assert.ok(events[0].jobCreatedAt >= jobCreatedAt && events[0].jobCreatedAt <= Date.now());
  assert.equal(events[0].jobCreatedAfterSubscription, true);
  assert.equal(lateEvents[0].jobCreatedAt, events[0].jobCreatedAt);
  assert.equal(lateEvents[0].jobCreatedAfterSubscription, false, '即使创建时间相同，订阅前创建的Job也不能获得本轮证明');
  assert.equal(events[1].jobCreatedAt, undefined, '未观察创建的Job不能伪造来源');
  fn('AssignProcessToJobObject')(1, root);
  assert.equal(events[3].jobCreatedAt, undefined, '关闭后同号句柄不继承旧创建证明');
  fn('CreateJobObjectW')(null, null); library.func('__stdcall', 'CloseHandle')(1);
  fn('CreateJobObjectW')(null, 'existing'); fn('AssignProcessToJobObject')(1, root);
  assert.equal(events[4].jobCreatedAt, undefined, '具名CreateJob可能打开既有Job，不能记录为本轮新建');
  unsubscribe(); stopLate(); fn('CloseHandle')(2); assert.equal(events.length, 5);
});

test('关闭失败观测只记录已关联Job的有界原始计数，不增加原生调用或改写结果', async () => {
  const source = await readFile(new URL('../../packages/process-control-node/tests/helpers/windows-job-observer.mjs', import.meta.url), 'utf8');
  const script = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText
    .replace(/^import .*;\r?\n/gmu, '').replace('export async function', 'async function');
  const calls = [];
  const library = { func: (...declaration) => {
    const name = declaration.find(value => typeof value === 'string' && value !== '__stdcall');
    return (...args) => {
      calls.push(name);
      if (name === 'QueryInformationJobObject') {
        if (args[1] === 1) { Object.assign(args[2], { active: 2, total: 3 }); return 0; }
        Object.assign(args[2], { assigned: 2, count: 1 }); return 1;
      }
      if (name === 'GetLastError') return 87;
      return 1;
    };
  } };
  const native = { load: () => library, struct: value => value, pointer: value => value, inout: value => value };
  const original = native.load, sandbox = { Buffer, basename, loadOwnedNative: async () => native };
  runInNewContext(`${script}\nglobalThis.observe = observeWindowsJobMembers;`, sandbox);
  const observation = await sandbox.observe(), kernel = native.load('kernel32.dll');
  const query = kernel.func('__stdcall', 'QueryInformationJobObject');
  query(99, 3, {}); assert.equal(observation.queries.length, 0, '不记录未确认归属的Job');
  kernel.func('__stdcall', 'AssignProcessToJobObject')(1, 2);
  for (let index = 0; index < 140; index++) {
    const value = {}; assert.equal(query(1, 3, value), 1); assert.deepEqual(value, { assigned: 2, count: 1 });
  }
  assert.equal(calls.length, 142, '诊断不能补发查询');
  assert.equal(observation.queries.length, 128); assert.equal(observation.queryFailures.length, 32);
  assert.equal(observation.queryFailures[0].assigned, 2); assert.equal(observation.queryFailures[0].count, 1);
  assert.equal(observation.queryFailures[0].queryOk, true); assert.equal(observation.queryFailures[0].class, 3);
  assert.equal(query(1, 1, {}), 0); assert.equal(kernel.func('__stdcall', 'GetLastError')(), 87);
  assert.equal(observation.queryFailures.at(-1).nativeCode, 87); assert.equal(observation.queryFailures.at(-1).queryOk, false);
  assert.equal(calls.length, 144, '失败路径仍只调用原查询和调用方自己的GetLastError');
  observation.restore(); assert.equal(native.load, original);
});

test('后端拒绝在归并前只记录有界分类，保持方法this、参数、原返回和原错误', async () => {
  const failures = [], budget = { deadline: 125 }, value = {};
  const original = Object.assign(new Error('token=private'), { code: 'PROCESS_SCOPE_UNKNOWN', details: { stage: 'QUERY_JOB_MEMBERS', nativeCode: 87 } });
  const backend = { attach: async () => value, bind: async () => undefined, force: async () => undefined, dispose: async () => undefined,
    empty: async function (...args) { assert.equal(this, backend); assert.deepEqual(args, [false, budget]); throw original; } };
  const wrapped = wrapWindowsJobBackend(backend, failures, () => 100);
  assert.equal(await wrapped.attach(10), value);
  await assert.rejects(wrapped.empty(false, budget), error => error === original);
  assert.deepEqual(failures, [{ method: 'empty', rootExited: false, remainingMs: 25, code: 'PROCESS_SCOPE_UNKNOWN', stage: 'QUERY_JOB_MEMBERS', nativeCode: 87 }]);
  assert.doesNotMatch(JSON.stringify(failures), /token|private/u);
});

test('同步后端失败同样透传，最多保留32条记录，观察器自身失败不替换原错误', () => {
  const error = new Error('private'), failures = [];
  const backend = Object.fromEntries(['attach', 'bind', 'empty', 'force', 'dispose'].map(method => [method, () => { throw error; }]));
  const wrapped = wrapWindowsJobBackend(backend, failures);
  for (let index = 0; index < 40; index++) assert.throws(() => wrapped.dispose(), value => value === error);
  assert.equal(failures.length, 32); assert.deepEqual(failures[0], { method: 'dispose' });
  const failingRecorder = wrapWindowsJobBackend(backend, Object.freeze([]), () => { throw new Error('recorder failed'); });
  assert.throws(() => failingRecorder.empty(false, { deadline: 125 }), value => value === error);
});
