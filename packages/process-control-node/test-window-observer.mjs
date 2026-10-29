import { createRequire } from 'node:module';
import process from 'node:process';
import { clearImmediate, clearInterval, clearTimeout, setImmediate, setInterval, setTimeout } from 'node:timers';
import { URL } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { loadOwnedNative } from './dist/owned-scope/native-loader.js';
import { createWindowsTestJobDiagnostics } from './test-process-diagnostics.mjs';
import { createWindowEventLedger } from './test-window-events.mjs';
import { createWindowsWindowHookPump } from './test-window-hook-pump.mjs';
import { createWindowsWindowJobSampler } from './test-window-job-sampler.mjs';

// 显式诊断工具；普通测试和公开包入口都不会启动此观察器。
export const createWindowsTestWindowObserver = async ({ native, onFlash, onGap = () => {}, eventLimit = 512, memberLimit = 512,
  protectedPids = [], reusableProtectedPids = [], hardProtectedPids = [] }) => {
  if (!Number.isSafeInteger(eventLimit) || eventLimit < 1 || eventLimit > 32768
    || !Number.isSafeInteger(memberLimit) || memberLimit < 1 || memberLimit > 32768) throw new RangeError('WINDOW_OBSERVER_LIMIT');
  if (!Array.isArray(protectedPids) || protectedPids.length > 63
    || protectedPids.some(pid => !Number.isSafeInteger(pid) || pid < 1 || pid > 0xffffffff)) throw new RangeError('WINDOW_PROTECTED_PIDS');
  if (!Array.isArray(hardProtectedPids) || hardProtectedPids.length > 63 || hardProtectedPids.some(pid => !protectedPids.includes(pid))) throw new RangeError('WINDOW_HARD_PROTECTED_PIDS');
  if (!Array.isArray(reusableProtectedPids) || reusableProtectedPids.length > 63 || new Set(reusableProtectedPids).size !== reusableProtectedPids.length
    || reusableProtectedPids.some(pid => !protectedPids.includes(pid) || hardProtectedPids.includes(pid) || pid === process.pid)) throw new RangeError('WINDOW_PROTECTED_PID_REUSE');
  native ??= await loadOwnedNative('win32');
  let stopping = false, resampling;
  const notify = (callback, value) => {
    stopping = true;
    clearImmediate(resampling); resampling = undefined;
    try { callback?.(value); } catch { ledger.gap('WINDOW_OBSERVER_CALLBACK_FAILED'); }
  };
  const ledger = createWindowEventLedger({ onFlash: value => notify(onFlash, value), onGap: reason => notify(onGap, reason), limit: eventLimit });
  const samplingFailures = [];
  const gap = (reason, details) => {
    ledger.gap(reason);
    if (details && samplingFailures.length < eventLimit) samplingFailures.push({ reason, ...details });
  };
  const worker = new Worker(new URL(import.meta.url), { workerData: { forgeWindowObserver: true } });
  const exited = new Promise(resolve => worker.once('exit', resolve));
  let ready = false, timer, sampling, unsubscribe, sampler, closed = false, closing;
  const pendingChecks = new Set();
  const started = new Promise((resolve, reject) => {
    timer = setTimeout(() => { gap('WINDOW_HOOK_READY_TIMEOUT'); reject(new Error('WINDOW_HOOK_READY_TIMEOUT')); }, 3_000);
    worker.on('message', event => {
      if (event.type === 'ready') { ready = event.messageDelivery === true; clearTimeout(timer); resolve(); }
      else if (event.type === 'window') {
        ledger.event(event.value);
        if (event.value.visible && !closed && !stopping) {
          const check = setTimeout(() => {
            pendingChecks.delete(check);
            for (const window of ledger.snapshot().unattributedWindows) {
              try { const proof = sampler?.outsideProof?.(window); if (proof) ledger.outside(proof); }
              catch { gap('WINDOW_OWNER_QUERY_FAILED', { pid: window.pid }); }
            }
            for (const reason of ledger.snapshot().gaps) if (reason.startsWith('UNATTRIBUTED_')) gap(reason);
          }, 25);
          pendingChecks.add(check);
        }
      }
      else if (event.type === 'gap') { gap(event.reason, event.details); if (!ready) reject(new Error(event.reason)); }
    });
    worker.on('error', error => { gap('WINDOW_WORKER_ERROR'); reject(error); });
    worker.on('exit', code => { if (!closed) gap('WINDOW_WORKER_EXIT'); if (!ready) reject(new Error(`WINDOW_WORKER_EXIT_${code}`)); });
  });
  const close = () => closing ??= (async () => {
      closed = true; stopping = true; clearTimeout(timer); clearInterval(sampling);
      clearImmediate(resampling); resampling = undefined;
      try { unsubscribe?.(); } catch (error) { gap('WINDOW_JOB_UNSUBSCRIBE_FAILED', { error: String(error?.message ?? error).slice(0, 128) }); }
      try { sampler?.close(); } catch (error) { gap('WINDOW_MEMBER_CLEANUP_FAILED', { error: String(error?.message ?? error).slice(0, 128) }); }
      for (const check of pendingChecks) clearTimeout(check); pendingChecks.clear();
      try { worker.postMessage({ type: 'stop' }); } catch { gap('WINDOW_WORKER_STOP_FAILED'); }
      let deadline;
      const result = await Promise.race([exited, new Promise(resolve => { deadline = setTimeout(() => resolve('timeout'), 1_000); })]);
      clearTimeout(deadline);
      if (result === 'timeout') {
        gap('WINDOW_WORKER_STOP_TIMEOUT');
        try { await worker.terminate(); } catch { gap('WINDOW_WORKER_TERMINATE_FAILED'); }
      }
      else if (result !== 0) gap('WINDOW_WORKER_EXIT_CODE');
    return { ready, ...ledger.snapshot(), ...sampler?.snapshot?.(), samplingFailures: [...samplingFailures] };
  })();
  try {
    await started;
    sampler = createWindowsWindowJobSampler(native, { member: value => ledger.member(value), gap },
      { limit: memberLimit, protectedPids: [...new Set([process.pid, ...protectedPids])], reusableProtectedPids, hardProtectedPids });
    const sample = () => {
      if (closed || stopping) return;
      try {
        sampler.sample();
        // 同次最多立即补查一次，不等待计数收敛；原生失败或窗口通知已经停止时不得再查。
        if (!closed && !stopping && sampler.hasPending()) sampler.sample();
        // 仍待确认才让出事件投递；不为调度复制全部历史，原20毫秒上限仍由sampler严格判断。
        if (!closed && !stopping && resampling === undefined && sampler.hasPending()) {
          resampling = setImmediate(() => { resampling = undefined; sample(); });
        }
      } catch (error) { gap('JOB_WINDOW_SAMPLING_FAILED', { stage: 'sample', nativeException: String(error?.message ?? error).slice(0, 160) }); }
    };
    unsubscribe = createWindowsTestJobDiagnostics(native).observeJobs(event => {
      try {
        if (event.type === 'assigned') { sampler.assigned(event.job, event.rootPid, event.jobCreatedAt, event.jobCreatedAfterSubscription); sample(); }
        else sampler.closing(event.job);
      } catch (error) { gap('JOB_WINDOW_SAMPLING_FAILED', { stage: event.type, nativeException: String(error?.message ?? error).slice(0, 160) }); }
    });
    sampling = setInterval(sample, 10);
    return { close, snapshot: () => ({ ready, ...ledger.snapshot(), ...sampler?.snapshot?.(), samplingFailures: [...samplingFailures] }) };
  } catch (error) { error.observation = await close(); throw error; }
};

if (!isMainThread && workerData?.forgeWindowObserver) {
  let pump, interval;
  try {
    const native = createRequire(import.meta.url)('koffi');
    pump = createWindowsWindowHookPump(native, event => parentPort.postMessage(event));
    interval = setInterval(() => pump.pump(), 5);
    parentPort.on('message', event => {
      if (event.type !== 'stop') return;
      clearInterval(interval); pump.pump(); pump.close(); parentPort.close();
    });
  } catch (error) {
    clearInterval(interval); pump?.close();
    parentPort.postMessage({ type: 'gap', reason: String(error?.message ?? error).slice(0, 128) });
    parentPort.close();
  }
}
