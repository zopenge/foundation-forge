import { ProcessControlError, processControlErrorCodes, type ProcessIdentityReader, type ReadProcessIdentityRequest, type ReadProcessIdentityResult } from '@openge/forge-process-control';
import { loadOwnedNative } from './owned-scope/native-loader.js';

type FileTime = { low: number; high: number };
interface NativeIdentityApi {
  open(pid: number): bigint | null;
  processId(handle: bigint): number;
  signaled(handle: bigint): boolean;
  creation(handle: bigint): FileTime;
  close(handle: bigint): void;
}
const backend = 'windows-native';
let apiPromise: Promise<NativeIdentityApi> | undefined;
const failure = (stage: string, details: Readonly<Record<string, unknown>> = {}, cause?: unknown) =>
  new ProcessControlError(processControlErrorCodes.commandFailed, { backend, stage, ...details }, cause);
const structured = (error: unknown) => error instanceof ProcessControlError ? error : failure('NATIVE_CALL', {}, error);
const active = (signal?: AbortSignal) => { if (signal?.aborted) throw new ProcessControlError(processControlErrorCodes.operationAborted); };

async function bindApi(): Promise<NativeIdentityApi> {
  const k = await loadOwnedNative('win32'), lib = k.load('kernel32.dll');
  const time = k.struct({ low: 'uint32_t', high: 'uint32_t' });
  if (k.sizeof(time) !== 8) throw failure('FILETIME_ABI');
  const open = lib.func('void * __stdcall OpenProcess(uint32_t access, int32_t inherit, uint32_t pid)');
  const pid = lib.func('uint32_t __stdcall GetProcessId(void *handle)');
  const wait = lib.func('uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t milliseconds)');
  const times = lib.func('__stdcall', 'GetProcessTimes', 'int32_t', ['void *', k.out(k.pointer(time)), k.out(k.pointer(time)), k.out(k.pointer(time)), k.out(k.pointer(time))]);
  const close = lib.func('int32_t __stdcall CloseHandle(void *handle)');
  const lastError = lib.func('uint32_t __stdcall GetLastError()');
  const error = (stage: string, details: Readonly<Record<string, unknown>> = {}) => failure(stage, { nativeCode: Number(lastError()), ...details });
  return {
    open: value => {
      // 只读身份和零时等待，无终止/内存/继承权限；参数范围在进入FFI前验证。
      const handle: bigint | null = open(0x00101000, 0, value);
      if (handle) return handle;
      const nativeCode = Number(lastError());
      if (nativeCode === 87) return null;
      throw failure('OPEN_PROCESS', { nativeCode });
    },
    processId: handle => { const value = Number(pid(handle)); if (!value) throw error('PROCESS_ID'); return value; },
    signaled: handle => {
      const value = Number(wait(handle, 0));
      if (value === 0) return true; if (value === 258) return false;
      throw error('PROCESS_WAIT', { waitResult: value });
    },
    creation: handle => {
      const created: FileTime = { low: 0, high: 0 }, exited = { low: 0, high: 0 }, kernel = { low: 0, high: 0 }, user = { low: 0, high: 0 };
      if (!times(handle, created, exited, kernel, user)) throw error('GET_PROCESS_TIMES');
      if (![created.low, created.high].every(value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff)) throw failure('FILE_TIME');
      return created;
    },
    close: handle => { if (!close(handle)) throw error('CLOSE_HANDLE'); },
  };
}
function nativeApi(): Promise<NativeIdentityApi> {
  // 只缓存不可变ABI绑定；每次读取仍单独打开句柄并查询，不缓存PID或身份结果。
  apiPromise ??= bindApi().catch((error: unknown) => {
    apiPromise = undefined;
    throw new ProcessControlError(processControlErrorCodes.unsupportedBackend, { backend, stage: 'NATIVE_LOAD' }, error);
  });
  return apiPromise;
}
function initialize(signal?: AbortSignal): Promise<NativeIdentityApi> {
  const loading = nativeApi();
  if (!signal) return loading;
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new ProcessControlError(processControlErrorCodes.operationAborted)); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    // 一个调用取消不取消共享加载；迟到的成功/失败均有接收方且不再发起查询。
    void loading.then(value => { signal.removeEventListener('abort', abort); if (signal.aborted) abort(); else resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', abort); if (signal.aborted) abort(); else reject(error); });
  });
}
function query(api: NativeIdentityApi, request: ReadProcessIdentityRequest): ReadProcessIdentityResult {
  const handle = api.open(request.pid);
  if (!handle) { active(request.signal); return { status: 'ABSENT' }; }
  let result: ReadProcessIdentityResult | undefined, primary: ProcessControlError | undefined;
  try {
    active(request.signal);
    const observedPid = api.processId(handle);
    if (observedPid !== request.pid) throw failure('IDENTITY_BINDING', { pid: request.pid, observedPid });
    active(request.signal);
    if (api.signaled(handle)) result = { status: 'ABSENT' };
    else {
      active(request.signal); const created = api.creation(handle); active(request.signal);
      if (api.signaled(handle)) result = { status: 'ABSENT' };
      else {
        const milliseconds = ((BigInt(created.high) << 32n) + BigInt(created.low) - 116444736000000000n) / 10000n;
        result = { status: 'FOUND', identity: { pid: request.pid, startToken: `/Date(${milliseconds})/` } };
      }
    }
  } catch (error) { primary = structured(error); }
  try { api.close(handle); }
  catch (error) {
    const cleanup = structured(error);
    primary = primary ? new ProcessControlError(primary.code, { ...primary.details, cleanup: cleanup.details }, primary) : cleanup;
  }
  if (primary) throw primary;
  active(request.signal);
  if (!result) throw failure('IDENTITY_RESULT');
  return result;
}

/** 显式Windows x64原生reader；不改变旧reader，不枚举进程或回退到命令实现。 */
export function createWindowsNativeProcessIdentityReader(): ProcessIdentityReader {
  return { readIdentity: async ({ pid, signal }) => {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff)
      throw new ProcessControlError(processControlErrorCodes.invalidInput, { pid });
    active(signal);
    const api = await initialize(signal); active(signal);
    try { return query(api, { pid, ...(signal ? { signal } : {}) }); } catch (error) { throw structured(error); }
  } };
}
