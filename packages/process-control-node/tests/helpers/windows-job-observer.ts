import { Buffer } from 'node:buffer';
import { basename } from 'node:path';
import { loadOwnedNative } from '../../dist/owned-scope/native-loader.js';

interface MemberObservation {
  pid: number;
  belongs?: number | null;
  wait?: number;
  exitCode?: number | null;
  image?: string | null;
}

// 共享测试观测器透传真实 Win32 调用；最多保留 64 个自有成员，不记录参数、路径或环境。
export async function observeWindowsJobMembers() {
  const native = await loadOwnedNative('win32'), original = native.load;
  const kernel = original('kernel32.dll');
  const image = kernel.func('__stdcall', 'QueryFullProcessImageNameW', 'int32_t', ['void *', 'uint32_t', 'void *', native.inout(native.pointer('uint32_t'))]);
  const handles = new Map<unknown, MemberObservation>(), members: MemberObservation[] = [];
  native.load = (...args) => {
    const lib = original(...args);
    return new Proxy(lib, { get(target, key) {
      if (key !== 'func') return Reflect.get(target, key);
      return (...declaration: unknown[]) => {
        const fn = Reflect.apply(target.func, target, declaration) as (...values: unknown[]) => unknown;
        const named = (name: string) => declaration.some(value => typeof value === 'string' && value.includes(name));
        return (...values: unknown[]) => {
          const result = fn(...values);
          if (named('OpenProcess') && result && values[0] === (0x1000 | 0x100000) && typeof values[2] === 'number') handles.set(result, { pid: values[2] });
          const row = handles.get(values[0]);
          if (row && named('IsProcessInJob') && Array.isArray(values[2])) row.belongs = result ? Number(values[2][0]) : null;
          if (row && named('WaitForSingleObject')) row.wait = Number(result);
          if (row && named('GetExitCodeProcess') && Array.isArray(values[1])) {
            row.exitCode = result ? Number(values[1][0]) : null;
            if (row.exitCode === 259) {
              const buffer = Buffer.alloc(65536), size = [32768];
              row.image = image(values[0], 0, buffer, size) ? basename(buffer.toString('utf16le', 0, (size[0] ?? 0) * 2)) : null;
            }
          }
          if (row && named('CloseHandle')) {
            members.push(row); if (members.length > 64) members.shift(); handles.delete(values[0]);
          }
          return result;
        };
      };
    } });
  };
  return { members, restore: () => { native.load = original; } };
}
