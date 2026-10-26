import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';

const module = await import('../test-worker-budget.mjs').catch(error => ({ error }));
const create = options => { assert.ifError(module.error); return module.createTestWorkerBudget(options); };
const gate = () => { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; };

test('one and two worker tasks share capacity without multiplying package and file pools', async () => {
  const budget = create({ limit: 2 }), first = gate(), second = gate(), order = [];
  const a = budget.run({ name: 'ordinary', workers: 1 }, async lease => { order.push(['ordinary', lease.workers]); await first.promise; });
  const b = budget.run({ name: 'file-pool', workers: 2 }, async lease => { order.push(['file-pool', lease.workers]); await second.promise; });
  const c = budget.run({ name: 'later', workers: 1 }, async lease => { order.push(['later', lease.workers]); });
  await setImmediate(); assert.deepEqual(order, [['ordinary', 1]]);
  first.resolve(); await a; await setImmediate();
  assert.deepEqual(order, [['ordinary', 1], ['file-pool', 2]]);
  assert.equal(budget.summary().activeWorkers, 2);
  second.resolve(); await Promise.all([b, c]);
  assert.deepEqual(order, [['ordinary', 1], ['file-pool', 2], ['later', 1]]);
  assert.deepEqual(budget.summary(), { limit: 2, activeWorkers: 0, peakWorkers: 2, started: 3, finished: 3, failed: false });
});

test('two independent single-worker consumers overlap and a serial budget keeps them separate', async () => {
  for (const limit of [1, 2]) {
    const budget = create({ limit }), release = gate(); let running = 0, peak = 0;
    const work = [0, 1].map(index => budget.run({ name: `consumer-${index}`, workers: 1 }, async () => {
      running++; peak = Math.max(peak, running); await release.promise; running--;
    }));
    await setImmediate(); assert.equal(peak, limit);
    release.resolve(); await Promise.all(work); assert.equal(running, 0);
  }
});

test('first failure stops queued work while a running sibling retains its slot through cleanup', async () => {
  const budget = create({ limit: 2 }), rejectNow = gate(), cleanup = gate(); let laterStarted = false, siblingClosed = false;
  const a = budget.run({ name: 'failing', workers: 1 }, async () => { await rejectNow.promise; throw new Error('fixture failure'); });
  const b = budget.run({ name: 'sibling', workers: 1 }, async () => { try { await cleanup.promise; } finally { siblingClosed = true; } });
  const c = budget.run({ name: 'queued', workers: 1 }, async () => { laterStarted = true; });
  const aRejected = assert.rejects(a, /fixture failure/u), cRejected = assert.rejects(c, /fixture failure/u);
  await setImmediate(); rejectNow.resolve(); await Promise.all([aRejected, cRejected]);
  assert.equal(siblingClosed, false); assert.equal(laterStarted, false); assert.equal(budget.summary().activeWorkers, 1);
  cleanup.resolve(); await b;
  assert.equal(siblingClosed, true); assert.equal(budget.summary().activeWorkers, 0);
  await assert.rejects(budget.run({ name: 'after-failure', workers: 1 }, async () => {}), /fixture failure/u);
});

test('a failing task cannot release its worker before its asynchronous finally finishes', async () => {
  const budget = create({ limit: 1 }), close = gate(); let nextStarted = false;
  const work = budget.run({ name: 'not-closed', workers: 1 }, async () => { try { throw new Error('failed'); } finally { await close.promise; } });
  const next = budget.run({ name: 'next', workers: 1 }, async () => { nextStarted = true; });
  const rejected = assert.rejects(work, /failed/u), cancelled = assert.rejects(next, /failed/u);
  await setImmediate(); assert.equal(nextStarted, false); assert.equal(budget.summary().activeWorkers, 1);
  close.resolve(); await Promise.all([rejected, cancelled]); assert.equal(nextStarted, false);
});

test('invalid limits and worker requests cannot start a task outside the approved budget', async () => {
  assert.ifError(module.error);
  for (const limit of [0, 3, -1, 1.5, NaN]) assert.throws(() => create({ limit }), /worker budget/u);
  const budget = create({ limit: 1 }); let started = false;
  for (const workers of [0, 2, 1.5]) await assert.rejects(budget.run({ name: 'invalid', workers }, async () => { started = true; }), /worker/u);
  assert.equal(started, false); assert.equal(budget.summary().activeWorkers, 0);
});

test('a non-Error rejection also stops the queued task', async () => {
  const budget = create({ limit: 1 }); let started = false;
  const first = budget.run({ name: 'non-error', workers: 1 }, () => Promise.reject(undefined));
  const next = budget.run({ name: 'queued', workers: 1 }, async () => { started = true; });
  const rejected = assert.rejects(first), cancelled = assert.rejects(next);
  await Promise.all([rejected, cancelled]); assert.equal(started, false); assert.equal(budget.summary().failed, true);
});

test('observer failure rejects before execution and leaves no occupied worker', async () => {
  const budget = create({ limit: 2, onEvent: () => { throw new Error('log unavailable'); } }); let started = false;
  await assert.rejects(budget.run({ name: 'not-started', workers: 2 }, async () => { started = true; }), /log unavailable/u);
  assert.equal(started, false); assert.equal(budget.summary().activeWorkers, 0); assert.equal(budget.summary().failed, true);
});
