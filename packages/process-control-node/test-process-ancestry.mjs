import { loadOwnedNative } from './dist/owned-scope/native-loader.js';

const validPid = value => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff;
const failure = (stage, details = {}, cause) => Object.assign(new Error(`FIXTURE_ANCESTRY_NATIVE_${stage}`, { cause }), { details: { stage, ...details } });
const active = signal => signal?.throwIfAborted();

function bindApi(native) {
  const fileTime = native.struct({ low: 'uint32_t', high: 'uint32_t' });
  // x64 PBI 的前四个指针槽仅作占位；不解引用 PEB、内存或其他进程数据。
  const basic = native.struct({ reserved1: 'uintptr_t', pebBaseAddress: 'uintptr_t', reserved2a: 'uintptr_t',
    reserved2b: 'uintptr_t', uniqueProcessId: 'uintptr_t', parentProcessId: 'uintptr_t' });
  if (native.sizeof('void *') !== 8 || native.sizeof(fileTime) !== 8 || native.sizeof(basic) !== 48
    || native.offsetof(basic, 'uniqueProcessId') !== 32 || native.offsetof(basic, 'parentProcessId') !== 40) throw failure('ABI');
  const kernel = native.load('kernel32.dll'), ntdll = native.load('ntdll.dll');
  const open = kernel.func('void * __stdcall OpenProcess(uint32_t access, int32_t inherit, uint32_t pid)');
  const pid = kernel.func('uint32_t __stdcall GetProcessId(void *handle)');
  const wait = kernel.func('uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t milliseconds)');
  const times = kernel.func('__stdcall', 'GetProcessTimes', 'int32_t', ['void *', ...Array(4).fill(native.out(native.pointer(fileTime)))]);
  const query = ntdll.func('__stdcall', 'NtQueryInformationProcess', 'int32_t', ['void *', 'uint32_t',
    native.out(native.pointer(basic)), 'uint32_t', native.out(native.pointer('uint32_t'))]);
  const close = kernel.func('int32_t __stdcall CloseHandle(void *handle)');
  const lastError = kernel.func('uint32_t __stdcall GetLastError()');
  const failedCall = (stage, details = {}) => failure(stage, { nativeCode: Number(lastError()), ...details });
  return {
    open: value => {
      // 仅查询有限信息与零时等待；没有终止、内存或句柄继承权限。
      const handle = open(0x101000, 0, value);
      if (handle) return handle;
      const nativeCode = Number(lastError());
      if (nativeCode === 87) return null;
      throw failure('OPEN_PROCESS', { nativeCode });
    },
    processId: handle => Number(pid(handle)),
    signaled: handle => {
      const result = Number(wait(handle, 0));
      if (result === 0) return true;
      if (result === 258) return false;
      throw failedCall('PROCESS_WAIT', { waitResult: result });
    },
    creation: handle => {
      const created = { low: 0, high: 0 };
      if (!times(handle, created, { low: 0, high: 0 }, { low: 0, high: 0 }, { low: 0, high: 0 })) throw failedCall('GET_PROCESS_TIMES');
      if (![created.low, created.high].every(value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff)) throw failure('FILE_TIME');
      return ((BigInt(created.high) << 32n) + BigInt(created.low) - 116444736000000000n) / 10000n;
    },
    parent: (handle, expectedPid) => {
      const value = { reserved1: 0, pebBaseAddress: 0, reserved2a: 0, reserved2b: 0, uniqueProcessId: 0, parentProcessId: 0 }, length = [0];
      const status = Number(query(handle, 0, value, 48, length));
      const nativePid = Number(value.uniqueProcessId), parentPid = Number(value.parentProcessId);
      if (status !== 0 || length[0] !== 48 || !validPid(nativePid) || nativePid !== expectedPid
        || !Number.isSafeInteger(parentPid) || parentPid < 0 || parentPid > 0xffffffff) throw failure('PROCESS_BASIC_INFORMATION', { status, returnedLength: length[0] });
      return parentPid;
    },
    close: handle => { if (!close(handle)) throw failedCall('CLOSE_HANDLE'); },
  };
}

/** 仅供仓库夹具读取明确 PID 的描述符，不进入公开导出或发布文件。 */
export function createWindowsTestProcessDescriptorReader({ loadNative = () => loadOwnedNative('win32') } = {}) {
  let loading;
  const initialize = signal => {
    // 只缓存 ABI；每次描述符查询都重新打开句柄、读取时间戳和父边。
    loading ??= Promise.resolve().then(loadNative).then(bindApi).catch(error => {
      loading = undefined;
      throw error instanceof Error && error.message.startsWith('FIXTURE_ANCESTRY_NATIVE_') ? error : failure('LOAD', {}, error);
    });
    if (!signal) return loading;
    return new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      // 单个取消不会取消共享加载；迟到成功与失败都有接收方且不会查询该请求。
      void loading.then(value => { signal.removeEventListener('abort', abort); if (signal.aborted) abort(); else resolve(value); },
        error => { signal.removeEventListener('abort', abort); if (signal.aborted) abort(); else reject(error); });
    });
  };
  return { readDescriptor: async ({ pid, signal }) => {
    if (!validPid(pid)) throw failure('INVALID_PID');
    active(signal); const api = await initialize(signal); active(signal);
    const handle = api.open(pid);
    if (!handle) { active(signal); return undefined; }
    let result, primary, failed = false;
    try {
      active(signal);
      if (api.processId(handle) !== pid) throw failure('IDENTITY_BINDING');
      active(signal);
      if (!api.signaled(handle)) {
        const created = api.creation(handle); active(signal);
        const parentPid = api.parent(handle, pid); active(signal);
        if (!api.signaled(handle)) result = { pid, parentPid, startToken: `/Date(${created})/` };
      }
    } catch (error) { primary = error; failed = true; }
    try { api.close(handle); }
    catch (error) {
      if (failed) primary = Object.assign(new Error(primary instanceof Error ? primary.message : 'FIXTURE_ANCESTRY_NATIVE_CALL', { cause: primary }),
        { details: { ...(primary?.details ?? {}), cleanup: error?.details ?? { stage: 'CLOSE_HANDLE' } } });
      else { primary = error; failed = true; }
    }
    if (failed) throw primary;
    active(signal); return result;
  } };
}
