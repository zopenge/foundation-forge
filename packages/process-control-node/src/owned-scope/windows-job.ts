import { ProcessControlError, processControlErrorCodes, type ProcessIdentity } from '@openge/forge-process-control';
import { loadOwnedNative } from './native-loader.js';
import type { ScopeBackend } from './backend.js';
import type { SupervisorPort } from './supervisor.js';
export async function createWindowsJob(port: SupervisorPort): Promise<ScopeBackend> {
  const k = await loadOwnedNative('win32'), lib = k.load('kernel32.dll');
  const basic = k.struct({ processTimeLimit: 'int64_t', jobTimeLimit: 'int64_t', flags: 'uint32_t', minWorkingSet: 'size_t', maxWorkingSet: 'size_t', processLimit: 'uint32_t', affinity: 'uintptr_t', priority: 'uint32_t', scheduling: 'uint32_t' });
  const io = k.struct({ readCount: 'uint64_t', writeCount: 'uint64_t', otherCount: 'uint64_t', readBytes: 'uint64_t', writeBytes: 'uint64_t', otherBytes: 'uint64_t' });
  const limits = k.struct({ basic, io, processMemory: 'size_t', jobMemory: 'size_t', peakProcessMemory: 'size_t', peakJobMemory: 'size_t' });
  const accounting = k.struct({ userTime: 'int64_t', kernelTime: 'int64_t', periodUser: 'int64_t', periodKernel: 'int64_t', faults: 'uint32_t', total: 'uint32_t', active: 'uint32_t', terminated: 'uint32_t' });
  const fileTime = k.struct({ low: 'uint32_t', high: 'uint32_t' });
  const processList = k.struct({ assigned: 'uint32_t', count: 'uint32_t', ids: k.array('uintptr_t', 4096) });
  const create = lib.func('void * __stdcall CreateJobObjectW(void *attributes, str16 name)');
  // Win32 BOOL 是 32 位 int，不是 C99 的一字节 bool。
  const set = lib.func('__stdcall', 'SetInformationJobObject', 'int32_t', ['void *', 'int', k.pointer(limits), 'uint32_t']);
  const readLimits = lib.func('__stdcall', 'QueryInformationJobObject', 'int32_t', ['void *', 'int', k.out(k.pointer(limits)), 'uint32_t', 'void *']);
  const query = lib.func('__stdcall', 'QueryInformationJobObject', 'int32_t', ['void *', 'int', k.out(k.pointer(accounting)), 'uint32_t', 'void *']);
  const members = lib.func('__stdcall', 'QueryInformationJobObject', 'int32_t', ['void *', 'int', k.out(k.pointer(processList)), 'uint32_t', 'void *']);
  const assign = lib.func('int32_t __stdcall AssignProcessToJobObject(void *job, void *process)');
  const open = lib.func('void * __stdcall OpenProcess(uint32_t access, int32_t inherit, uint32_t pid)');
  const times = lib.func('__stdcall', 'GetProcessTimes', 'int32_t', ['void *', k.out(k.pointer(fileTime)), k.out(k.pointer(fileTime)), k.out(k.pointer(fileTime)), k.out(k.pointer(fileTime))]);
  const inJob = lib.func('__stdcall', 'IsProcessInJob', 'int32_t', ['void *', 'void *', k.out(k.pointer('int'))]);
  const wait = lib.func('uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t timeout)');
  const exitCode = lib.func('__stdcall', 'GetExitCodeProcess', 'int32_t', ['void *', k.out(k.pointer('uint32_t'))]);
  const terminate = lib.func('int32_t __stdcall TerminateJobObject(void *job, uint32_t code)');
  const close = lib.func('int32_t __stdcall CloseHandle(void *handle)');
  const lastError = lib.func('uint32_t __stdcall GetLastError()');
  const fail = (stage: string) => new ProcessControlError(processControlErrorCodes.scopeUnknown, { stage, nativeCode: Number(lastError()) });
  let job: bigint | null = create(null, null), processHandle: bigint | null = null, actual: ProcessIdentity | undefined;
  if (!job) throw fail('CREATE_JOB');
  try {
    const value = { basic: { processTimeLimit: 0, jobTimeLimit: 0, flags: 0x2000, minWorkingSet: 0, maxWorkingSet: 0, processLimit: 0, affinity: 0, priority: 0, scheduling: 0 },
      io: { readCount: 0, writeCount: 0, otherCount: 0, readBytes: 0, writeBytes: 0, otherBytes: 0 }, processMemory: 0, jobMemory: 0, peakProcessMemory: 0, peakJobMemory: 0 };
    if (k.sizeof(limits) !== 144 || k.sizeof(accounting) !== 48 || !set(job, 9, value, k.sizeof(limits))) throw fail('SET_JOB_LIMITS');
    if (!readLimits(job, 9, value, k.sizeof(limits), null) || (value.basic.flags & 0x2000) === 0 || (value.basic.flags & 0x1800) !== 0) throw fail('JOB_LIMIT_READBACK');
  } catch (error) { close(job); job = null; throw error; }
  return {
    attach: async pid => {
      if (!job || processHandle) throw fail('ATTACH_STATE');
      processHandle = open(0x0100 | 0x0001 | 0x1000, 0, pid);
      if (!processHandle) throw fail('OPEN_ROOT');
      const created = { low: 0, high: 0 }, exited = { low: 0, high: 0 }, kernel = { low: 0, high: 0 }, user = { low: 0, high: 0 };
      if (!times(processHandle, created, exited, kernel, user)) throw fail('ROOT_TIMES');
      const milliseconds = ((BigInt(created.high) << 32n) + BigInt(created.low) - 116444736000000000n) / 10000n;
      actual = { pid, startToken: `/Date(${String(milliseconds)})/` };
      if (!assign(job, processHandle)) throw fail('ASSIGN_JOB');
    },
    bind: async identity => { if (!actual || actual.pid !== identity.pid || actual.startToken !== identity.startToken) throw new ProcessControlError(processControlErrorCodes.scopeBinding, { reason: 'ROOT_IDENTITY' }); },
    empty: async rootExited => {
      if (!job || !actual) throw fail('QUERY_STATE');
      const value = { userTime: 0, kernelTime: 0, periodUser: 0, periodKernel: 0, faults: 0, total: 0, active: 0, terminated: 0 };
      const expected = rootExited ? 0 : 1, deadline = Date.now() + Math.min(1000, port.terminationTimeoutMs);
      const readMembers = () => {
        const list = { assigned: 0, count: 0, ids: Array<bigint>(4096).fill(0n) };
        if (!members(job, 3, list, k.sizeof(processList), null) || list.count !== list.assigned || list.count > 4096) throw fail('QUERY_JOB_MEMBERS');
        return list;
      };
      const rootOnly = (list: ReturnType<typeof readMembers>) => list.count === expected && (rootExited || Number(list.ids[0]) === actual?.pid);
      for (;;) {
        if (!query(job, 1, value, k.sizeof(accounting), null)) throw fail('QUERY_JOB');
        if (value.active === expected) return true;
        const list = readMembers();
        if (!rootExited && !list.ids.slice(0, list.count).some(pid => Number(pid) === actual?.pid)) throw fail('JOB_ROOT_MEMBERSHIP');
        for (const pid of list.ids.slice(0, list.count)) {
          if (!rootExited && Number(pid) === actual.pid) continue;
          const handle = open(0x1000 | 0x100000, 0, Number(pid));
          if (!handle) {
            // 已删除实例不能打开；只有再次取得完整的 root-only Job 表才可继续，不以 PID 缺失代替关闭证据。
            if (Number(lastError()) !== 87 || !rootOnly(readMembers())) throw fail('JOB_MEMBER_INSTANCE');
            break;
          }
          let active = false;
          try {
            const belongs = [0];
            if (!inJob(handle, job, belongs) || belongs[0] !== 1) throw fail('JOB_MEMBER_OWNERSHIP');
            const state = Number(wait(handle, 0));
            if (state !== 0 && state !== 258) throw fail('JOB_MEMBER_WAIT');
            if (state === 258) {
              // ExitProcess 的终止状态可先于进程对象触发；STILL_ACTIVE 之外的状态已证明退出。
              const code = [0];
              if (!exitCode(handle, code)) throw fail('JOB_MEMBER_EXIT_STATUS');
              active = code[0] === 259;
            }
          } catch (error) { close(handle); throw error; }
          if (!close(handle)) throw fail('CLOSE_MEMBER_HANDLE');
          if (active) return false;
        }
        // 完整成员表或稳定句柄已证明没有存活后代，才等待 accounting 同步；存活成员没有宽限。
        if (Date.now() >= deadline) throw fail('JOB_ACCOUNTING_DEADLINE');
        await new Promise(accept => setTimeout(accept, 10));
      }
    },
    force: async () => { if (job && !terminate(job, 125)) throw fail('TERMINATE_JOB'); },
    dispose: async () => {
      let failed = false;
      if (processHandle) { if (!close(processHandle)) failed = true; else processHandle = null; }
      if (job) { if (!close(job)) failed = true; else job = null; }
      if (failed) throw fail('CLOSE_HANDLES');
    },
  };
}
