import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const boundary = vi.hoisted(() => ({ load: vi.fn(), fallback: vi.fn(() => { throw new Error('UNPLANNED_FALLBACK'); }) }));
vi.mock('../src/owned-scope/native-loader.js', () => ({ loadOwnedNative: boundary.load }));
vi.mock('../src/provider.js', () => ({ createWindowsProcessIdentityReader: boundary.fallback }));
beforeEach(() => { vi.resetModules(); vi.resetAllMocks(); });
afterEach(() => { expect(boundary.fallback).not.toHaveBeenCalled(); });

type FileTime = { low: number; high: number };
function fixture() {
  let creation = 116444736000000000n + 1700000000123n * 10000n + 9999n;
  const open = vi.fn<(access: number, inherit: number, pid: number) => bigint | null>(() => 1n);
  const pid = vi.fn<(handle: bigint) => number>(() => 42), wait = vi.fn<(handle: bigint, milliseconds: number) => number>(() => 258);
  const times = vi.fn((_handle: bigint, created: FileTime) => {
    created.low = Number(creation & 0xffffffffn); created.high = Number(creation >> 32n); return 1;
  });
  const close = vi.fn<(handle: bigint) => number>(() => 1), lastError = vi.fn(() => 5);
  const methods = new Map<string, unknown>([['OpenProcess', open], ['GetProcessId', pid], ['WaitForSingleObject', wait],
    ['GetProcessTimes', times], ['CloseHandle', close], ['GetLastError', lastError]]);
  const module = { struct: vi.fn(() => 'FILETIME'), pointer: (value: unknown) => value, out: (value: unknown) => value, sizeof: vi.fn(() => 8),
    load: vi.fn(() => ({ func: (definition: string, name?: string) => {
      const key = name ?? /\b(\w+)\(/u.exec(definition)?.[1];
      if (!key || !methods.has(key)) throw new Error(`unexpected native binding: ${definition}/${name}`);
      return methods.get(key);
    } })) };
  boundary.load.mockResolvedValue(module);
  return { module, open, pid, wait, times, close, lastError, setCreation: (value: bigint) => { creation = value; } };
}
const reader = async () => (await import('../src/windows-native-identity.js')).createWindowsNativeProcessIdentityReader();

test('reads a live exact identity with bounded rights and closes its fresh handle', async () => {
  const f = fixture(), value = await reader();
  await expect(value.readIdentity({ pid: 42 })).resolves.toEqual({ status: 'FOUND', identity: { pid: 42, startToken: '/Date(1700000000123)/' } });
  expect(f.open).toHaveBeenCalledExactlyOnceWith(0x00101000, 0, 42);
  expect(f.wait.mock.calls).toEqual([[1n, 0], [1n, 0]]); expect(f.close).toHaveBeenCalledExactlyOnceWith(1n);
});

test('shares ABI bindings but reads a fresh creation time and handle every time', async () => {
  const f = fixture(), value = await reader();
  expect(await value.readIdentity({ pid: 42 })).toMatchObject({ identity: { startToken: '/Date(1700000000123)/' } });
  f.setCreation(116444736000000000n + 1700000000124n * 10000n);
  expect(await value.readIdentity({ pid: 42 })).toMatchObject({ identity: { startToken: '/Date(1700000000124)/' } });
  expect(boundary.load).toHaveBeenCalledOnce(); expect(f.open).toHaveBeenCalledTimes(2); expect(f.close).toHaveBeenCalledTimes(2);
});
test('preserves negative millisecond tokens without floating point rounding', async () => {
  const f = fixture(); f.setCreation(116444736000000000n - 12345n);
  expect(await (await reader()).readIdentity({ pid: 42 })).toMatchObject({ identity: { startToken: '/Date(-1)/' } });
});
test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 0x100000000, Number.MAX_SAFE_INTEGER + 1])('rejects PID %s before loading or querying', async pid => {
  const f = fixture();
  await expect((await reader()).readIdentity({ pid })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(boundary.load).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled();
});
test('returns absent only for the known fixed-argument open error 87', async () => {
  const f = fixture(); f.open.mockReturnValue(null); f.lastError.mockReturnValue(87);
  expect(await (await reader()).readIdentity({ pid: 42 })).toEqual({ status: 'ABSENT' }); expect(f.close).not.toHaveBeenCalled();
});
test.each([5, 0, 6])('rejects open error %s instead of declaring absence', async nativeCode => {
  const f = fixture(); f.open.mockReturnValue(null); f.lastError.mockReturnValue(nativeCode);
  await expect((await reader()).readIdentity({ pid: 42 })).rejects.toMatchObject({ code: 'COMMAND_FAILED', details: { stage: 'OPEN_PROCESS', nativeCode } });
  expect(f.close).not.toHaveBeenCalled();
});
test('does not read a timestamp from an already signaled process', async () => {
  const f = fixture(); f.wait.mockReturnValue(0);
  expect(await (await reader()).readIdentity({ pid: 42 })).toEqual({ status: 'ABSENT' });
  expect(f.times).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledOnce();
});
test('does not return the old identity when the process exits during its read', async () => {
  const f = fixture(); f.wait.mockReturnValueOnce(258).mockReturnValueOnce(0);
  expect(await (await reader()).readIdentity({ pid: 42 })).toEqual({ status: 'ABSENT' }); expect(f.close).toHaveBeenCalledOnce();
});
test('rejects a handle bound to another PID', async () => {
  const f = fixture(); f.pid.mockReturnValue(43);
  await expect((await reader()).readIdentity({ pid: 42 })).rejects.toMatchObject({ code: 'COMMAND_FAILED', details: { stage: 'IDENTITY_BINDING' } });
  expect(f.times).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledOnce();
});
test('retains a native PID-query failure', async () => {
  const f = fixture(); f.pid.mockReturnValue(0); f.lastError.mockReturnValue(6);
  await expect((await reader()).readIdentity({ pid: 42 })).rejects.toMatchObject({ code: 'COMMAND_FAILED', details: { stage: 'PROCESS_ID', nativeCode: 6 } });
  expect(f.close).toHaveBeenCalledOnce();
});
test.each([0xffffffff, 128])('rejects ambiguous wait result %s', async waitResult => {
  const f = fixture(); f.wait.mockReturnValue(waitResult);
  await expect((await reader()).readIdentity({ pid: 42 })).rejects.toMatchObject({ code: 'COMMAND_FAILED', details: { stage: 'PROCESS_WAIT', waitResult } });
  expect(f.times).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledOnce();
});
test('closes after a timestamp failure without declaring absence', async () => {
  const f = fixture(); f.times.mockReturnValue(0); f.lastError.mockReturnValue(299);
  await expect((await reader()).readIdentity({ pid: 42 })).rejects.toMatchObject({ code: 'COMMAND_FAILED', details: { stage: 'GET_PROCESS_TIMES', nativeCode: 299 } });
  expect(f.close).toHaveBeenCalledOnce();
});
test.each([-1, 0.5, 0x100000000])('rejects malformed FILETIME DWORD %s', async low => {
  const f = fixture(); f.times.mockImplementation((_handle, created) => { created.low = low; return 1; });
  await expect((await reader()).readIdentity({ pid: 42 })).rejects.toMatchObject({ code: 'COMMAND_FAILED', details: { stage: 'FILE_TIME' } });
  expect(f.close).toHaveBeenCalledOnce();
});
test('does not report success when its handle cannot be closed', async () => {
  const f = fixture(); f.close.mockReturnValue(0); f.lastError.mockReturnValue(6);
  await expect((await reader()).readIdentity({ pid: 42 })).rejects.toMatchObject({ code: 'COMMAND_FAILED', details: { stage: 'CLOSE_HANDLE', nativeCode: 6 } });
});
test('retains the first read failure and records a secondary close failure', async () => {
  const f = fixture(); f.times.mockReturnValue(0); f.close.mockReturnValue(0); f.lastError.mockReturnValueOnce(299).mockReturnValueOnce(6);
  await expect((await reader()).readIdentity({ pid: 42 })).rejects.toMatchObject({ code: 'COMMAND_FAILED',
    details: { stage: 'GET_PROCESS_TIMES', nativeCode: 299, cleanup: { stage: 'CLOSE_HANDLE', nativeCode: 6 } } });
});
test('rejects a pre-cancelled read before native loading', async () => {
  const f = fixture();
  await expect((await reader()).readIdentity({ pid: 42, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
  expect(boundary.load).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled();
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
test('captures the validated PID before asynchronous native initialization', async () => {
  const f = fixture(), gate = deferred<typeof f.module>(); boundary.load.mockReturnValue(gate.promise);
  const value = await reader(), request = { pid: 42 };
  const pending = value.readIdentity(request).then(result => ({ result }), (error: unknown) => ({ error }));
  request.pid = 0x10000002b; gate.resolve(f.module);
  await expect(pending).resolves.toMatchObject({ result: { status: 'FOUND', identity: { pid: 42 } } });
  expect(f.open).toHaveBeenCalledExactlyOnceWith(0x00101000, 0, 42);
});

test('retains the original cancellation signal when the caller changes its request', async () => {
  const f = fixture(), gate = deferred<typeof f.module>(); boundary.load.mockReturnValue(gate.promise);
  const value = await reader(), controller = new AbortController(), request = { pid: 42, signal: controller.signal };
  const pending = value.readIdentity(request).then(result => ({ result }), (error: unknown) => ({ error }));
  request.signal = new AbortController().signal;
  f.open.mockImplementation(() => { controller.abort(); return 1n; }); gate.resolve(f.module);
  await expect(pending).resolves.toMatchObject({ error: { code: 'OPERATION_ABORTED' } });
  expect(f.close).toHaveBeenCalledOnce();
});

test('cancels one shared initialization waiter without poisoning another or querying late', async () => {
  const f = fixture(), gate = deferred<typeof f.module>(); boundary.load.mockReturnValue(gate.promise);
  const value = await reader(), controller = new AbortController();
  const cancelled = value.readIdentity({ pid: 42, signal: controller.signal }).then(result => ({ result }), (error: unknown) => ({ error }));
  const continuing = value.readIdentity({ pid: 42 }).then(result => ({ result }), (error: unknown) => ({ error }));
  controller.abort(); await expect(cancelled).resolves.toMatchObject({ error: { code: 'OPERATION_ABORTED' } });
  expect(f.open).not.toHaveBeenCalled(); gate.resolve(f.module);
  await expect(continuing).resolves.toMatchObject({ result: { status: 'FOUND' } });
  expect(boundary.load).toHaveBeenCalledOnce(); expect(f.open).toHaveBeenCalledOnce(); expect(f.close).toHaveBeenCalledOnce();
});
test('handles a late initialization failure after cancellation without a late query', async () => {
  const f = fixture(), gate = deferred<typeof f.module>(); boundary.load.mockReturnValue(gate.promise);
  const controller = new AbortController(), value = await reader();
  const pending = value.readIdentity({ pid: 42, signal: controller.signal }).then(result => ({ result }), (error: unknown) => ({ error }));
  controller.abort(); await expect(pending).resolves.toMatchObject({ error: { code: 'OPERATION_ABORTED' } });
  gate.reject(new Error('fixture unavailable')); await new Promise(resolve => setTimeout(resolve, 0)); expect(f.open).not.toHaveBeenCalled();
});
test.each(['open', 'times', 'close'] as const)('keeps cancellation during %s from becoming a successful result', async stage => {
  const f = fixture(), controller = new AbortController();
  if (stage === 'open') f.open.mockImplementation(() => { controller.abort(); return 1n; });
  if (stage === 'times') f.times.mockImplementation(() => { controller.abort(); return 1; });
  if (stage === 'close') f.close.mockImplementation(() => { controller.abort(); return 1; });
  await expect((await reader()).readIdentity({ pid: 42, signal: controller.signal })).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
  expect(f.close).toHaveBeenCalledOnce();
});
test('preserves cancellation when cleanup also fails', async () => {
  const f = fixture(), controller = new AbortController();
  f.open.mockImplementation(() => { controller.abort(); return 1n; }); f.close.mockReturnValue(0); f.lastError.mockReturnValue(6);
  await expect((await reader()).readIdentity({ pid: 42, signal: controller.signal })).rejects.toMatchObject({
    code: 'OPERATION_ABORTED', details: { cleanup: { stage: 'CLOSE_HANDLE', nativeCode: 6 } },
  });
});
test('rejects a native load failure without falling back and permits a new explicit attempt', async () => {
  const f = fixture(); boundary.load.mockRejectedValueOnce(new Error('fixture missing prebuild')).mockResolvedValue(f.module);
  const value = await reader();
  await expect(value.readIdentity({ pid: 42 })).rejects.toMatchObject({ code: 'UNSUPPORTED_BACKEND', details: { stage: 'NATIVE_LOAD' } });
  expect(f.open).not.toHaveBeenCalled(); expect(await value.readIdentity({ pid: 42 })).toMatchObject({ status: 'FOUND' });
  expect(boundary.load).toHaveBeenCalledTimes(2);
});
test('rejects an incompatible ABI before opening a process', async () => {
  const f = fixture(); f.module.sizeof.mockReturnValue(16);
  await expect((await reader()).readIdentity({ pid: 42 })).rejects.toMatchObject({ code: 'UNSUPPORTED_BACKEND' }); expect(f.open).not.toHaveBeenCalled();
});
