import { runRelease } from '../../src/node.js';
import type { ReleaseReport, RunReleaseOptions } from '../../src/contracts.js';

/** 测试即使断言失败或超时，也先等待本轮真实运行完成取消，再回收 fixture。 */
export function managedRuns() {
  const pending = new Set<Promise<ReleaseReport>>(), controllers = new Set<AbortController>();
  return {
    run: async (options: RunReleaseOptions): Promise<ReleaseReport> => {
      const controller = new AbortController(); controllers.add(controller);
      const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
      const task = runRelease({ ...options, signal }); pending.add(task);
      try { return await task; } finally { pending.delete(task); controllers.delete(controller); }
    },
    close: async () => { for (const controller of controllers) controller.abort(); await Promise.allSettled([...pending]); },
  };
}
