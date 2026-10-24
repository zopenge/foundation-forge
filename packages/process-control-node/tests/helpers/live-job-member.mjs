import { loadOwnedNative } from '../../dist/owned-scope/native-loader.js';

/** 仅观察真实返回值；不伪造成员、归属或退出状态。 */
export async function observeLiveJobMember(targetPid, observed, run) {
  const native = await loadOwnedNative('win32'), original = native.load;
  const handles = new Set();
  native.load = (...args) => {
    const lib = original(...args), func = lib.func.bind(lib);
    return new Proxy(lib, { get(target, key) {
      if (key !== 'func') return Reflect.get(target, key);
      return (...declaration) => {
        const fn = func(...declaration);
        const named = name => declaration.some(value => typeof value === 'string' && value.includes(name));
        return (...values) => {
          const result = fn(...values);
          if (named('OpenProcess') && values[2] === targetPid() && result) handles.add(result);
          if (named('GetExitCodeProcess') && handles.has(values[0]) && result && values[1][0] === 259) observed();
          if (named('CloseHandle') && result) handles.delete(values[0]);
          return result;
        };
      };
    } });
  };
  try { return await run(); } finally { native.load = original; }
}
