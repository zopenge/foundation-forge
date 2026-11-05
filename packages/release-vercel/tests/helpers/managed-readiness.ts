import type { ReleaseReport } from '../../src/contracts.js';

/** 等待私有任务标记；调用方仍负责实际发布进程的取消与收尾。 */
export async function waitForManagedReady(pending: Promise<ReleaseReport>, observe: () => Promise<boolean>,
  { timeoutMs = 120_000, intervalMs = 100, signal: caller, started }:
  { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal; started?: Promise<void> } = {}): Promise<void> {
  const controller = new AbortController(), signal = caller ? AbortSignal.any([caller, controller.signal]) : controller.signal;
  let deadline: ReturnType<typeof setTimeout> | undefined, polling: Promise<void> | undefined;
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_accept, reject) => {
    abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
  });
  // 未被选中的完成分支也始终观察原拒绝；只在race选中它时传播原错误。
  const ended = pending.then(report => ({ kind: 'report' as const, report }), (error: unknown) => ({ kind: 'error' as const, error }));
  const assertPending = (value: Awaited<typeof ended>) => {
    if (value.kind === 'error') throw value.error;
    const report = value.report;
    throw new Error(`release finished before readiness: ${JSON.stringify({
      ok: report.ok, stage: report.stage, error: report.error,
      failedSteps: report.steps.filter(step => !step.ok).map(step => ({ name: step.name, exitCode: step.exitCode, durationMs: step.durationMs })),
    })}`);
  };
  try {
    signal.throwIfAborted();
    if (started) {
      const outcome = await Promise.race([started, ended, cancelled]);
      if (outcome) assertPending(outcome);
    }
    signal.throwIfAborted();
    deadline = setTimeout(() => controller.abort(new Error('managed readiness timed out')), timeoutMs);
    polling = (async () => {
    for (;;) {
      signal.throwIfAborted();
      const ready = await observe();
      signal.throwIfAborted();
      if (ready) return;
      await new Promise<void>((accept, reject) => {
        const finish = () => { signal.removeEventListener('abort', abort); accept(); };
        const timer = setTimeout(finish, intervalMs);
        const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
        signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      });
    }
    })();
    const outcome = await Promise.race([polling, ended, cancelled]);
    if (outcome) assertPending(outcome);
  } finally {
    signal.removeEventListener('abort', abort); controller.abort(); clearTimeout(deadline);
    if (polling) await Promise.allSettled([polling]);
  }
}
