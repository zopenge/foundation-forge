import { Buffer } from 'node:buffer';
import { win32 } from 'node:path';

const observers = new WeakMap();

// 仅供仓库测试适配器使用；读取 Provider 已打开并确认属于自有 Job 的成员句柄。
export const createWindowsTestJobDiagnostics = native => {
  if (observers.has(native)) return observers.get(native);
  const original = native.load.bind(native), kernel = original('kernel32.dll');
  const image = kernel.func('__stdcall', 'QueryFullProcessImageNameW', 'int32_t', ['void *', 'uint32_t', 'void *', native.inout(native.pointer('uint32_t'))]);
  const fileTime = native.struct({ low: 'uint32_t', high: 'uint32_t' });
  const times = kernel.func('__stdcall', 'GetProcessTimes', 'int32_t', ['void *', ...Array(4).fill(native.out(native.pointer(fileTime)))]);
  const basic = native.struct({ reserved1: 'uintptr_t', pebBaseAddress: 'uintptr_t', reserved2a: 'uintptr_t',
    reserved2b: 'uintptr_t', uniqueProcessId: 'uintptr_t', parentProcessId: 'uintptr_t' });
  if (native.sizeof('void *') !== 8 || native.sizeof(basic) !== 48 || native.offsetof(basic, 'uniqueProcessId') !== 32
    || native.offsetof(basic, 'parentProcessId') !== 40) throw new Error('TEST_JOB_DIAGNOSTICS_ABI');
  const parent = original('ntdll.dll').func('__stdcall', 'NtQueryInformationProcess', 'int32_t', ['void *', 'uint32_t',
    native.out(native.pointer(basic)), 'uint32_t', native.out(native.pointer('uint32_t'))]);
  const handles = new Map(), roots = new Map(), rows = new Map();
  native.load = (...args) => {
    const library = original(...args);
    if (args[0] !== 'kernel32.dll') return library;
    return new Proxy(library, { get(target, key) {
      if (key !== 'func') return Reflect.get(target, key);
      return (...declaration) => {
        const fn = Reflect.apply(target.func, target, declaration);
        const named = name => declaration.some(value => typeof value === 'string' && value.includes(name));
        return (...values) => {
          const result = fn(...values);
          if (named('OpenProcess') && result) handles.set(result, { pid: values[2], member: values[0] === 0x101000 });
          if (named('AssignProcessToJobObject') && result) roots.set(values[0], handles.get(values[1])?.pid);
          const row = handles.get(values[0]);
          if (row?.member && named('IsProcessInJob')) {
            row.belongs = Boolean(result && values[2][0] === 1);
            if (row.belongs) row.rootPid = roots.get(values[1]);
          }
          if (row?.member && named('WaitForSingleObject')) row.wait = Number(result);
          if (row?.member && named('GetExitCodeProcess') && result) {
            row.exitCode = Number(values[1][0]);
            if (row.belongs && row.rootPid && row.exitCode === 259) {
              row.lastActiveAt = new Date().toISOString();
              if (!row.sampled) {
                row.sampled = true;
                try {
                  const buffer = Buffer.alloc(65536), size = [32768];
                  row.image = image(values[0], 0, buffer, size) ? win32.basename(buffer.toString('utf16le', 0, size[0] * 2)) : null;
                  const created = { low: 0, high: 0 };
                  row.created = times(values[0], created, { low: 0, high: 0 }, { low: 0, high: 0 }, { low: 0, high: 0 })
                    ? String((BigInt(created.high) << 32n) + BigInt(created.low)) : null;
                  // 同一已确认归属的成员句柄只读父 PID；不打开父进程或扩大查询范围。
                  const info = { reserved1: 0, pebBaseAddress: 0, reserved2a: 0, reserved2b: 0, uniqueProcessId: 0, parentProcessId: 0 }, length = [0];
                  if (Number(parent(values[0], 0, info, 48, length)) !== 0 || length[0] !== 48
                    || Number(info.uniqueProcessId) !== row.pid || !Number.isSafeInteger(Number(info.parentProcessId))
                    || Number(info.parentProcessId) < 0 || Number(info.parentProcessId) > 0xffffffff) throw new Error('TEST_JOB_DIAGNOSTICS_PARENT');
                  row.parentPid = Number(info.parentProcessId);
                } catch { row.observationFailed = true; }
              }
            }
          }
          if (named('CloseHandle') && result) {
            if (row?.sampled && row.belongs && row.rootPid) {
              const kept = rows.get(row.rootPid) ?? [];
              const observation = { pid: row.pid, rootPid: row.rootPid, belongs: row.belongs, wait: row.wait,
                exitCode: row.exitCode, image: row.image, created: row.created, parentPid: row.parentPid, lastActiveAt: row.lastActiveAt,
                ...(row.observationFailed ? { observationFailed: true } : {}) };
              kept.push(observation); if (kept.length > 64) kept.shift(); rows.set(row.rootPid, kept);
            }
            handles.delete(values[0]); roots.delete(values[0]);
          }
          return result;
        };
      };
    } });
  };
  const observer = { take: rootPid => { const result = rows.get(rootPid) ?? []; rows.delete(rootPid); return result; } };
  observers.set(native, observer); return observer;
};
