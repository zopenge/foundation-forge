import { Buffer } from 'node:buffer';
import { basename } from 'node:path';
import { loadOwnedNative } from '../../dist/owned-scope/native-loader.js';

// 透传真实调用；最多保留64个自有成员、128条自有Job计数及32条计数异常，不补发查询或记录参数/环境。
export async function observeWindowsJobMembers() {
  const native = await loadOwnedNative('win32'), original = native.load;
  const kernel = original('kernel32.dll');
  const image = kernel.func('__stdcall', 'QueryFullProcessImageNameW', 'int32_t', ['void *', 'uint32_t', 'void *', native.inout(native.pointer('uint32_t'))]);
  const handles = new Map(), members = [];
  const jobs = new Map(), queries = [], queryFailures = [];
  let jobOrdinal = 0, failedQuery;
  native.load = (...args) => {
    const lib = original(...args);
    return new Proxy(lib, { get(target, key) {
      if (key !== 'func') return Reflect.get(target, key);
      return (...declaration) => {
        const fn = Reflect.apply(target.func, target, declaration);
        const named = name => declaration.some(value => typeof value === 'string' && value.includes(name));
        return (...values) => {
          if (!named('GetLastError')) failedQuery = undefined;
          const result = fn(...values);
          if (named('AssignProcessToJobObject') && result && !jobs.has(values[0])) jobs.set(values[0], ++jobOrdinal);
          const job = jobs.get(values[0]);
          if (named('QueryInformationJobObject') && job !== undefined && (values[1] === 1 || values[1] === 3)
            && values[2] !== null && typeof values[2] === 'object') {
            const value = values[2], entry = { at: Date.now(), job, class: values[1], queryOk: Boolean(result),
              ...(values[1] === 3 ? { assigned: Number(Reflect.get(value, 'assigned')), count: Number(Reflect.get(value, 'count')) }
                : { active: Number(Reflect.get(value, 'active')), total: Number(Reflect.get(value, 'total')) }) };
            queries.push(entry); if (queries.length > 128) queries.shift();
            if (!result || (entry.class === 3 && entry.assigned !== entry.count)) {
              queryFailures.push(entry); if (queryFailures.length > 32) queryFailures.shift();
              if (!result) failedQuery = entry;
            }
          }
          if (named('GetLastError') && failedQuery) { failedQuery.nativeCode = Number(result); failedQuery = undefined; }
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
          if (named('CloseHandle') && result) jobs.delete(values[0]);
          return result;
        };
      };
    } });
  };
  return { members, queries, queryFailures, restore: () => { native.load = original; } };
}
