import { appendFileSync } from 'node:fs';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestWorkerBudget, testWorkerLimit } from './test-worker-budget.mjs';
import { discoverTestProcessSupervisor, runTestProcess } from './test-process-runner.mjs';
import { openCheckCancellation } from './check-cancellation.mjs';
import { ensureTestTemporaryDirectory } from './test-temporary-directory.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const capture = async path => {
  if ((await stat(path)).size > 16 * 1024 * 1024) throw new Error(`test output capture exceeded 16 MiB: ${path}`);
  return readFile(path, 'utf8');
};
export const createTestRunContext = async ({ packages, workers = testWorkerLimit(), signal,
  supervisor, runProcess = runTestProcess }) => {
  testWorkerLimit(workers);
  // 嵌套上下文只缩小本地预约；共享事件流始终按根上下文的总上限审计。
  const observedWorkerLimit = testWorkerLimit(process.env.FORGE_CHECK_WORKER_CEILING ?? Math.max(2, workers));
  if (workers > observedWorkerLimit) throw new Error('local test worker allocation exceeds global worker ceiling');
  const inheritedCancellation = !signal && process.env.FORGE_CHECK_CANCEL_FILE ? openCheckCancellation() : undefined;
  signal ??= inheritedCancellation?.signal;
  try {
    signal?.throwIfAborted();
    const parent = await ensureTestTemporaryDirectory(repositoryRoot, resolve(repositoryRoot, '.tmp/check-runs'));
    const root = await mkdtemp(resolve(parent, 'run-'));
    const inheritedEvents = process.env.FORGE_CHECK_WORKER_EVENTS;
    const workerEvents = inheritedEvents ?? resolve(root, 'workers.jsonl');
    if (!inheritedEvents) await writeFile(workerEvents, '');
    supervisor ??= await discoverTestProcessSupervisor({ packages });
    signal?.throwIfAborted();
    const idleWaiters = new Set();
    const budget = createTestWorkerBudget({ limit: workers, onEvent: event => {
      try { appendFileSync(resolve(root, 'budget.jsonl'), `${JSON.stringify(event)}\n`); }
      finally { if (event.activeWorkers === 0) { for (const accept of idleWaiters) accept(); idleWaiters.clear(); } }
    } });
    const cancellation = new globalThis.AbortController(), pending = new Set();
    // 先撤销排队和下一次启动权限，再通知活动 Job；槽位仍由真实收尾归还。
    const stop = reason => {
      budget.stop(reason);
      cancellation.abort(reason);
    };
    const onAbort = () => stop(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const track = work => {
      const tracked = work.finally(() => { pending.delete(tracked); });
      pending.add(tracked); return tracked;
    };
    const drain = async () => {
      while (pending.size) await Promise.allSettled([...pending]);
      if (budget.summary().activeWorkers) await new Promise(accept => { idleWaiters.add(accept); });
    };
    let next = 0;
    const ownedJobs = new Set();
    const executeWithinSlot = async (spec, lease) => {
      const logRoot = spec.logRoot ?? resolve(root, 'jobs', String(next++));
      process.stdout.write(`test worker task: ${spec.name} (${lease.workers}/${budget.limit}); logs ${logRoot}\n`);
      const childWorkers = spec.nestedWorkerLimit ?? lease.workers;
      if (childWorkers < 1 || childWorkers > lease.workers) throw new Error('nested worker allocation exceeds its lease');
      let result;
      try { result = await runProcess({ ...spec, supervisor, logRoot,
        signal: spec.signal ? globalThis.AbortSignal.any([cancellation.signal, spec.signal]) : cancellation.signal, env: { ...(spec.env ?? process.env),
        FORGE_CHECK_TEST_WORKERS: String(childWorkers), VITEST_MAX_WORKERS: String(childWorkers),
        FORGE_CHECK_WORKER_CEILING: String(observedWorkerLimit),
        FORGE_CHECK_JOB_ROOT: logRoot, FORGE_CHECK_WORKER_EVENTS: workerEvents } });
      } catch (error) {
        // pre-abort 没有 scope 或日志；不可用 ENOENT 覆盖原始取消原因。
        if (error?.result) {
          if (error.result.jobId) ownedJobs.add(error.result.jobId);
          const failures = [error];
          try {
            const stdout = await capture(resolve(logRoot, 'stdout.log')), stderr = await capture(resolve(logRoot, 'stderr.log'));
            error.message += `\n${stdout}\n${stderr}`;
          } catch (captureError) { failures.push(captureError); }
          if (failures.length > 1) throw new AggregateError(failures, 'test failure and output capture failure', { cause: error });
        }
        throw error;
      }
      ownedJobs.add(result.jobId);
      cancellation.signal.throwIfAborted();
      spec.signal?.throwIfAborted();
      const stdout = await capture(resolve(logRoot, 'stdout.log')), stderr = await capture(resolve(logRoot, 'stderr.log'));
      cancellation.signal.throwIfAborted();
      spec.signal?.throwIfAborted();
      process.stdout.write(stdout); process.stderr.write(stderr);
      return { ...result, logRoot, stdout, stderr };
    };
    let executingWorkers = 0;
    const execute = (spec, lease) => track((async () => {
      cancellation.signal.throwIfAborted();
      spec.signal?.throwIfAborted();
      testWorkerLimit(lease.workers);
      if (budget.summary().failed || executingWorkers + lease.workers > budget.limit) throw new Error('test worker allocation is stopped or already occupied');
      executingWorkers += lease.workers;
      try { return await executeWithinSlot(spec, lease); }
      finally { executingWorkers -= lease.workers; }
    })());
    return { root, workerEvents, budget, execute,
      signal: cancellation.signal,
      cancel: async reason => { stop(reason); await drain(); },
      run: spec => track(budget.run({ name: spec.name, workers: spec.workers ?? 1 }, lease => execute(spec, lease))),
      finalize: async () => {
        if (cancellation.signal.aborted) await drain();
        const active = new Map(); let peak = 0;
        for (const line of (await readFile(workerEvents, 'utf8')).split(/\r?\n/u).filter(Boolean)) {
          const event = JSON.parse(line), key = `${event.jobId}:${event.pid}:${event.kind}`;
          if (event.type === 'start') active.set(key, event);
          if (event.type === 'finish') active.delete(key);
          if (event.type === 'scope-closed') for (const [id, value] of active) if (value.jobId === event.jobId) active.delete(id);
          peak = Math.max(peak, active.size);
        }
        const remainingWorkers = [...active.values()].filter(value => !inheritedEvents || ownedJobs.has(value.jobId));
        const summary = { ...budget.summary(), observedWorkerLimit, observedPeakWorkers: peak, remainingWorkers };
        await writeFile(resolve(root, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
        signal?.removeEventListener('abort', onAbort);
        inheritedCancellation?.close();
        if (peak > observedWorkerLimit || remainingWorkers.length || summary.activeWorkers || executingWorkers) throw new Error(`test worker closure or global worker ceiling failed; see ${root}`);
        return summary;
      },
    };
  } catch (error) { inheritedCancellation?.close(); throw error; }
};
