export const testWorkerTiers = Object.freeze([1, 2, 4, 8]);

export const testWorkerLimit = (value = process.env.FORGE_CHECK_TEST_WORKERS ?? '2') => {
  const limit = Number(value);
  if (!testWorkerTiers.some(tier => String(tier) === String(value))) throw new Error('test worker budget must be 1, 2, 4 or 8');
  return limit;
};

// 整套验收共享一次预约；包内池只能使用传入的 lease，不能再创建子预算。
export const createTestWorkerBudget = ({ limit = testWorkerLimit(), onEvent = () => {} } = {}) => {
  testWorkerLimit(limit);
  const queue = [];
  let activeWorkers = 0, peakWorkers = 0, started = 0, finished = 0, failure;
  const asError = value => value instanceof Error ? value : new Error('test task failed', { cause: value });
  const event = (type, task = {}) => {
    try { onEvent({ type, ...task, activeWorkers, limit, at: new Date().toISOString() }); }
    catch (error) { return asError(error); }
  };
  const stop = error => {
    if (failure === undefined) { failure = asError(error); event('stop'); }
    for (const task of queue.splice(0)) task.reject(failure);
  };
  const dispatch = () => {
    while (failure === undefined && queue.length && activeWorkers + queue[0].workers <= limit) {
      const task = queue.shift();
      activeWorkers += task.workers; peakWorkers = Math.max(peakWorkers, activeWorkers); started++;
      const settle = (ok, value) => {
        activeWorkers -= task.workers; finished++;
        const observerError = event('finish', { name: task.name, workers: task.workers });
        if (!ok || observerError) { const error = ok ? observerError : asError(value); stop(error); task.reject(error); }
        else task.resolve(value);
        dispatch();
      };
      const observerError = event('start', { name: task.name, workers: task.workers });
      if (observerError) { settle(false, observerError); continue; }
      Promise.resolve().then(() => task.run(Object.freeze({ name: task.name, workers: task.workers, limit })))
        .then(value => { settle(true, value); }, error => { settle(false, error); })
        .catch(error => { stop(error); task.reject(error); });
    }
  };
  return {
    limit,
    run: ({ name, workers }, run) => new Promise((resolve, reject) => {
      if (!Number.isSafeInteger(workers) || workers < 1 || workers > limit) { reject(new Error('invalid test worker request')); return; }
      if (failure !== undefined) { reject(failure); return; }
      queue.push({ name, workers, run, resolve, reject }); dispatch();
    }),
    stop,
    summary: () => ({ limit, activeWorkers, peakWorkers, started, finished, failed: failure !== undefined }),
  };
};
