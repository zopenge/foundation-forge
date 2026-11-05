/** 只推进指定命令期限；其余启动、身份、关闭与观察期限仍使用真实时钟。 */
export function completionDeadline(interval: number, { once = false } = {}) {
  if (!Number.isSafeInteger(interval) || interval <= 0) throw new Error('INVALID_COMPLETION_CLOCK');
  let elapsed = 0, captured = false;
  const pending = new Map<ReturnType<typeof setTimeout>, { at: number; fire(): void }>();
  const timers = {
    setTimeout: new Proxy(globalThis.setTimeout, { apply(target, receiver, args) {
      if (args[1] !== interval || typeof args[0] !== 'function' || once && captured) return Reflect.apply(target, receiver, args);
      captured = true;
      const handle = globalThis.setTimeout(() => {}, 0);
      pending.set(handle, { at: elapsed + interval, fire: () => Reflect.apply(args[0], undefined, args.slice(2)) });
      return handle;
    } }),
    clearTimeout: new Proxy(globalThis.clearTimeout, { apply(target, receiver, args) {
      pending.delete(args[0]); return Reflect.apply(target, receiver, args);
    } }),
  };
  return { timers, interval, pendingCount: () => pending.size,
    advance(milliseconds: number) {
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || !Number.isSafeInteger(elapsed + milliseconds))
        throw new Error('INVALID_COMPLETION_CLOCK');
      elapsed += milliseconds;
      for (const [handle, value] of [...pending]) if (value.at <= elapsed) {
        pending.delete(handle); globalThis.clearTimeout(handle); value.fire();
      }
    },
    dispose() { for (const handle of pending.keys()) globalThis.clearTimeout(handle); pending.clear(); },
  };
}
