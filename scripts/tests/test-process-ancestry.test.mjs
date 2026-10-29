import assert from 'node:assert/strict';
import test from 'node:test';

const ancestry = await import('../../packages/process-control-node/test-process-ancestry.mjs').catch(error => ({ error }));
const epoch = 116444736000000000n;

function fixture() {
  const state = { handle: 1n, processId: 42, waits: [258, 258], creation: epoch + 1700000000123n * 10000n + 9999n,
    timesStatus: 1, uniqueProcessId: 42n, parentProcessId: 10n, ntstatus: 0, returnedLength: 48,
    closeStatus: 1, nativeCode: 5, pointerSize: 8, basicSize: 48, parentOffset: 40 };
  const calls = { loads: 0, libraries: [], bindings: [], open: [], pid: [], wait: [], times: [], query: [], close: [] };
  const methods = {
    OpenProcess: (...args) => { calls.open.push(args); state.onOpen?.(); return state.handle; },
    GetProcessId: handle => { calls.pid.push(handle); return state.processId; },
    WaitForSingleObject: (...args) => { calls.wait.push(args); return state.waits.shift() ?? 258; },
    GetProcessTimes: (handle, created) => {
      calls.times.push(handle); created.low = state.low ?? Number(state.creation & 0xffffffffn);
      created.high = Number(state.creation >> 32n); state.onTimes?.(); return state.timesStatus;
    },
    NtQueryInformationProcess: (handle, informationClass, basic, size, returnedLength) => {
      calls.query.push([handle, informationClass, size]); basic.uniqueProcessId = state.uniqueProcessId;
      basic.parentProcessId = state.parentProcessId; returnedLength[0] = state.returnedLength; return state.ntstatus;
    },
    CloseHandle: handle => { calls.close.push(handle); state.onClose?.(); return state.closeStatus; },
    GetLastError: () => state.nativeCode,
  };
  const native = {
    struct: fields => ({ fields }), pointer: value => value, out: value => value,
    sizeof: value => typeof value === 'string' ? state.pointerSize : 'low' in value.fields ? 8 : state.basicSize,
    offsetof: (_type, field) => field === 'uniqueProcessId' ? 32 : state.parentOffset,
    load: library => {
      calls.libraries.push(library); assert.ok(['kernel32.dll', 'ntdll.dll'].includes(library));
      return { func: (definition, name) => {
        const key = name ?? /\b(\w+)\(/u.exec(definition)?.[1];
        assert.ok(key && Object.hasOwn(methods, key), `unexpected native binding: ${definition}/${name}`);
        calls.bindings.push(key); return methods[key];
      } };
    },
  };
  const create = () => {
    assert.ifError(ancestry.error);
    return ancestry.createWindowsTestProcessDescriptorReader({ loadNative: async () => { calls.loads++; return native; } });
  };
  return { state, calls, native, create };
}

test('祖先描述符用只读同句柄绑定 PID、FILETIME 和父边，并在读取前后零时复核存活', async () => {
  const f = fixture(), reader = f.create();
  assert.deepEqual(await reader.readDescriptor({ pid: 42 }), { pid: 42, parentPid: 10, startToken: '/Date(1700000000123)/' });
  assert.deepEqual(f.calls.open, [[0x101000, 0, 42]]); assert.deepEqual(f.calls.pid, [1n]);
  assert.deepEqual(f.calls.wait, [[1n, 0], [1n, 0]]); assert.deepEqual(f.calls.query, [[1n, 0, 48]]);
  assert.deepEqual(f.calls.close, [1n]); assert.deepEqual(f.calls.libraries, ['kernel32.dll', 'ntdll.dll']);
  assert.equal(f.calls.bindings.length, 7);
});

test('只缓存 ABI 绑定，每次重新打开 PID 和读取身份', async () => {
  const f = fixture(), reader = f.create();
  await reader.readDescriptor({ pid: 42 }); f.state.creation += 10000n;
  assert.equal((await reader.readDescriptor({ pid: 42 })).startToken, '/Date(1700000000124)/');
  assert.equal(f.calls.loads, 1); assert.equal(f.calls.open.length, 2); assert.equal(f.calls.close.length, 2);
});

test('已退出或明确不存在的 PID 不能成为祖先证据', async () => {
  for (const mode of ['open-absent', 'already-exited', 'exited-during-read']) {
    const f = fixture();
    if (mode === 'open-absent') { f.state.handle = null; f.state.nativeCode = 87; }
    if (mode === 'already-exited') f.state.waits = [0];
    if (mode === 'exited-during-read') f.state.waits = [258, 0];
    assert.equal(await f.create().readDescriptor({ pid: 42 }), undefined);
    assert.equal(f.calls.close.length, mode === 'open-absent' ? 0 : 1);
    if (mode !== 'exited-during-read') assert.equal(f.calls.query.length, 0);
  }
});

test('访问拒绝不能回退、枚举或宣称 PID 不存在', async () => {
  const f = fixture(); f.state.handle = null;
  await assert.rejects(f.create().readDescriptor({ pid: 42 }), /FIXTURE_ANCESTRY_NATIVE_OPEN_PROCESS/u);
  assert.equal(f.calls.close.length, 0); assert.equal(f.calls.open.length, 1);
});

test('拒绝错误句柄 PID、PBI PID 和超范围父 PID，并释放句柄', async () => {
  for (const [field, value] of [['processId', 43], ['uniqueProcessId', 43n], ['parentProcessId', 0x100000000n], ['parentProcessId', -1n]]) {
    const f = fixture(); f.state[field] = value;
    await assert.rejects(f.create().readDescriptor({ pid: 42 }), /FIXTURE_ANCESTRY_NATIVE_(IDENTITY_BINDING|PROCESS_BASIC_INFORMATION)/u);
    assert.deepEqual(f.calls.close, [1n]);
  }
});

test('拒绝失败 NTSTATUS 和不完整 PBI 返回长度', async () => {
  for (const [field, value] of [['ntstatus', -1073741823], ['ntstatus', 1], ['returnedLength', 40], ['returnedLength', 0]]) {
    const f = fixture(); f.state[field] = value;
    await assert.rejects(f.create().readDescriptor({ pid: 42 }), /FIXTURE_ANCESTRY_NATIVE_PROCESS_BASIC_INFORMATION/u);
    assert.deepEqual(f.calls.close, [1n]);
  }
});

test('拒绝非 x64 或不兼容 PBI 布局，且不打开进程', async () => {
  for (const [field, value] of [['pointerSize', 4], ['basicSize', 40], ['parentOffset', 32]]) {
    const f = fixture(); f.state[field] = value;
    await assert.rejects(f.create().readDescriptor({ pid: 42 }), /FIXTURE_ANCESTRY_NATIVE_ABI/u);
    assert.equal(f.calls.open.length, 0);
  }
});

test('拒绝非法 FILETIME、时间查询失败和未知等待结果', async () => {
  for (const mode of ['filetime', 'times', 'wait']) {
    const f = fixture();
    if (mode === 'filetime') f.state.low = -1;
    if (mode === 'times') f.state.timesStatus = 0;
    if (mode === 'wait') f.state.waits = [0xffffffff];
    await assert.rejects(f.create().readDescriptor({ pid: 42 }), /FIXTURE_ANCESTRY_NATIVE_(FILE_TIME|GET_PROCESS_TIMES|PROCESS_WAIT)/u);
    assert.deepEqual(f.calls.close, [1n]);
  }
});

test('关闭失败不能变成有效证据，并保留先前读取失败', async () => {
  const f = fixture(); f.state.closeStatus = 0;
  await assert.rejects(f.create().readDescriptor({ pid: 42 }), /FIXTURE_ANCESTRY_NATIVE_CLOSE_HANDLE/u);
  const failed = fixture(); failed.state.timesStatus = 0; failed.state.closeStatus = 0;
  await assert.rejects(failed.create().readDescriptor({ pid: 42 }), error => {
    assert.match(error.message, /FIXTURE_ANCESTRY_NATIVE_GET_PROCESS_TIMES/u);
    assert.match(error.cause.message, /FIXTURE_ANCESTRY_NATIVE_GET_PROCESS_TIMES/u);
    assert.equal(error.details.cleanup.stage, 'CLOSE_HANDLE'); return true;
  });
});

test('非法 PID 和预取消必须在加载与 FFI 之前拒绝', async () => {
  for (const pid of [0, -1, 1.5, Number.NaN, 0x100000000]) {
    const f = fixture(); await assert.rejects(f.create().readDescriptor({ pid }), /FIXTURE_ANCESTRY_NATIVE_INVALID_PID/u);
    assert.equal(f.calls.loads, 0); assert.equal(f.calls.open.length, 0);
  }
  const f = fixture();
  await assert.rejects(f.create().readDescriptor({ pid: 42, signal: globalThis.AbortSignal.abort() }));
  assert.equal(f.calls.loads, 0);
});

test('读取与关闭时的取消均不能返回描述符，并关闭已打开句柄', async () => {
  for (const hook of ['onOpen', 'onTimes', 'onClose']) {
    const f = fixture(), controller = new globalThis.AbortController(); f.state[hook] = () => controller.abort();
    await assert.rejects(f.create().readDescriptor({ pid: 42, signal: controller.signal }));
    assert.deepEqual(f.calls.close, [1n]);
  }
});

test('共享加载的单次取消不等待加载完成，也不产生迟到查询', async () => {
  assert.ifError(ancestry.error);
  const f = fixture(), controller = new globalThis.AbortController(); let loaded;
  const gate = new Promise(resolve => { loaded = resolve; });
  const reader = ancestry.createWindowsTestProcessDescriptorReader({ loadNative: () => gate });
  const cancelled = reader.readDescriptor({ pid: 42, signal: controller.signal });
  const continuing = reader.readDescriptor({ pid: 42 });
  controller.abort(); await assert.rejects(cancelled); assert.equal(f.calls.open.length, 0);
  loaded(f.native); assert.equal((await continuing).pid, 42); assert.equal(f.calls.open.length, 1);
});
