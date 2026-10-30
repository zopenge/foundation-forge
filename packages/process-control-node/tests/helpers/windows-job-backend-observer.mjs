import { performance } from 'node:perf_hooks';

// 测试专用：在supervisor归并关闭原因前保留拒绝分类，不改结果或追加原生查询。
export const wrapWindowsJobBackend = (backend, failures, now = () => performance.now()) => {
  const wrapped = { ...backend };
  for (const method of ['attach', 'bind', 'empty', 'force', 'dispose']) {
    const original = backend[method];
    const rejected = (error, args) => {
      try {
        const details = error?.details;
        const safe = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value);
        const budget = method === 'empty' ? args[1] : undefined;
        const remaining = typeof budget?.deadline === 'number' ? budget.deadline - now() : undefined;
        failures.push({ method,
          ...(method === 'empty' ? { rootExited: args[0] } : {}),
          ...(Number.isFinite(remaining) ? { remainingMs: remaining } : {}),
          ...(safe(error?.code) ? { code: error.code } : {}),
          ...(safe(details?.stage) ? { stage: details.stage } : {}),
          ...(Number.isInteger(details?.nativeCode) && details.nativeCode >= 0 && details.nativeCode <= 0xffffffff
            ? { nativeCode: details.nativeCode } : {}) });
        if (failures.length > 32) failures.shift();
      } catch { /* 诊断失败不替换原始错误，不记录消息、路径、堆栈或参数。 */ }
      throw error;
    };
    wrapped[method] = function (...args) {
      let result;
      try { result = Reflect.apply(original, backend, args); }
      catch (error) { return rejected(error, args); }
      return result && typeof result.then === 'function' ? result.then(undefined, error => rejected(error, args)) : result;
    };
  }
  return wrapped;
};
