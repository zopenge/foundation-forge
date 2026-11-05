import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { runFullCheck } from '../check-full.mjs';
import { createTestWorkerBudget } from '../test-worker-budget.mjs';

const gate = () => { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; };
const eight = t => {
  const previous = process.env.FORGE_CHECK_TEST_WORKERS;
  process.env.FORGE_CHECK_TEST_WORKERS = '8';
  t.after(() => { if (previous === undefined) Reflect.deleteProperty(process.env, 'FORGE_CHECK_TEST_WORKERS'); else process.env.FORGE_CHECK_TEST_WORKERS = previous; });
};

test('eight-slot full starts no script or static I/O while consumer installation is incomplete', async t => {
  eight(t);
  const installed = gate(), budget = createTestWorkerBudget({ limit: 8 }), calls = [];
  const work = runFullCheck({ run: async name => { calls.push(name); },
    createContext: async () => ({ budget, cancel: async () => {}, finalize: async () => {} }),
    verify: async ({ onBuilt, onConsumerReady }) => { await onBuilt({ packages: [] }); await installed.promise; await onConsumerReady(); },
    scriptTests: async () => { calls.push('scripts'); }, coverage: async () => { calls.push('coverage'); },
  });
  const settled = Promise.allSettled([work]);
  try { await setImmediate(); assert.deepEqual(calls, []); }
  finally { installed.resolve(); await settled; }
  await work; assert.ok(calls.includes('scripts')); assert.ok(calls.includes('coverage'));
});

for (const first of ['scripts', 'install']) test(`eight-slot full waits for both readiness conditions when ${first} finishes first`, async t => {
  eight(t);
  const scripts = gate(), install = gate(), coverageDone = gate(), consumerDone = gate();
  const budget = createTestWorkerBudget({ limit: 8 });
  let coverageStarted = false, consumerStarted = false, coverageClosed = false, consumerClosed = false, finalized = 0, requested;
  const context = { budget, cancel: async () => {}, finalize: async () => {
    assert.equal(budget.summary().activeWorkers, 0); assert.equal(coverageClosed, true); assert.equal(consumerClosed, true); finalized++;
  } };
  let serial;
  const work = runFullCheck({ run: async () => {}, createContext: async () => context,
    scriptTests: async () => { await scripts.promise; },
    verify: async ({ onBuilt, onConsumerReady, serialConsumerChecks }) => {
      serial = serialConsumerChecks; await onBuilt({ packages: [] }); await install.promise; await onConsumerReady?.();
      await budget.run({ name: 'consumer', workers: 1 }, async () => {
        consumerStarted = true; try { await consumerDone.promise; } finally { consumerClosed = true; }
      });
    },
    coverage: ({ workers }) => {
      requested = workers;
      return budget.run({ name: 'coverage', workers: workers ?? 8 }, async () => {
        coverageStarted = true; try { await coverageDone.promise; } finally { coverageClosed = true; }
      });
    },
  });
  const settled = Promise.allSettled([work]);
  try {
    await setImmediate();
    (first === 'scripts' ? scripts : install).resolve(); await setImmediate();
    assert.equal(coverageStarted, false);
    (first === 'scripts' ? install : scripts).resolve(); await setImmediate();
    assert.equal(coverageStarted, true); assert.equal(consumerStarted, true);
    assert.equal(requested, 6); assert.equal(serial, true); assert.equal(budget.summary().activeWorkers, 7);
    coverageDone.resolve(); await setImmediate(); assert.equal(finalized, 0);
  } finally { scripts.resolve(); install.resolve(); coverageDone.resolve(); consumerDone.resolve(); await settled; }
  await work;
  assert.equal(finalized, 1); assert.equal(budget.summary().peakWorkers, 7);
});

test('eight-slot full refuses missing consumer readiness instead of silently skipping coverage', async t => {
  eight(t);
  const budget = createTestWorkerBudget({ limit: 8 }); let coverageStarted = false, finalized = 0;
  await assert.rejects(runFullCheck({ run: async () => {}, createContext: async () => ({ budget,
    cancel: async () => {}, finalize: async () => { finalized++; } }),
    verify: async ({ onBuilt }) => { await onBuilt({ packages: [] }); }, scriptTests: async () => {},
    coverage: async () => { coverageStarted = true; },
  }), /CONSUMER_READY_REQUIRED/u);
  assert.equal(coverageStarted, false); assert.equal(finalized, 1);
});

test('eight-slot full refuses a duplicate readiness signal and joins started work', async t => {
  eight(t);
  const budget = createTestWorkerBudget({ limit: 8 }); let finalized = 0;
  await assert.rejects(runFullCheck({ run: async () => {}, createContext: async () => ({ budget,
    cancel: async () => {}, finalize: async () => { assert.equal(budget.summary().activeWorkers, 0); finalized++; } }),
    verify: async ({ onBuilt, onConsumerReady }) => { await onBuilt({ packages: [] }); await onConsumerReady?.(); await onConsumerReady?.(); },
    scriptTests: async () => {}, coverage: async () => {},
  }), /CONSUMER_READY_DUPLICATE/u);
  assert.equal(finalized, 1);
});

test('cancellation after readiness cannot complete until active coverage and consumer work drain', async t => {
  eight(t);
  const controller = new globalThis.AbortController(), closing = gate(), entered = gate(), reason = new Error('cancel full');
  const budget = createTestWorkerBudget({ limit: 8 }); let closed = 0, finalized = false, settled = false;
  const context = { budget, cancel: async () => {}, finalize: async () => { assert.equal(closed, 2); finalized = true; } };
  const work = runFullCheck({ signal: controller.signal, run: async () => {}, createContext: async () => context,
    verify: async ({ onBuilt, onConsumerReady }) => { await onBuilt({ packages: [] }); await onConsumerReady?.();
      await budget.run({ name: 'consumer', workers: 1 }, async () => { entered.resolve(); try { await closing.promise; } finally { closed++; } }); },
    scriptTests: async () => {}, coverage: ({ workers }) => budget.run({ name: 'coverage', workers: workers ?? 8 }, async () => {
      entered.resolve(); try { await closing.promise; } finally { closed++; }
    }),
  });
  const rejected = assert.rejects(work, error => error === reason);
  work.then(() => { settled = true; }, () => { settled = true; });
  try { await entered.promise; await setImmediate(); controller.abort(reason); await setImmediate(); assert.equal(settled, false); assert.equal(finalized, false); }
  finally { closing.resolve(); await rejected; }
  assert.equal(finalized, true); assert.equal(budget.summary().activeWorkers, 0);
});

for (const phase of ['scripts', 'install']) test(`eight-slot ${phase} failure prevents coverage and drains cancellation`, async t => {
  eight(t);
  const failure = new Error(`${phase} failed`), closed = gate(), cancelled = gate();
  const budget = createTestWorkerBudget({ limit: 8 });
  let coverageStarted = false, finalized = false, finished = false;
  const work = runFullCheck({ run: async () => {}, createContext: async () => ({ budget,
    cancel: async () => { cancelled.resolve(); await closed.promise; },
    finalize: async () => { finalized = true; },
  }), verify: async ({ onBuilt, onConsumerReady }) => {
    await onBuilt({ packages: [] });
    if (phase === 'install') throw failure;
    await onConsumerReady();
    await closed.promise;
  }, scriptTests: async () => { if (phase === 'scripts') throw failure; },
  coverage: async () => { coverageStarted = true; } });
  const rejected = assert.rejects(work, error => error === failure);
  work.then(() => { finished = true; }, () => { finished = true; });
  try { await cancelled.promise; await setImmediate(); assert.equal(finished, false); assert.equal(finalized, false); }
  finally { closed.resolve(); await rejected; }
  assert.equal(coverageStarted, false); assert.equal(finalized, true); assert.equal(budget.summary().activeWorkers, 0);
});

test('six-slot coverage failure cancels and joins the active consumer before finalization', async t => {
  eight(t);
  const failure = new Error('coverage failed'), entered = gate(), closed = gate(), cancelled = gate();
  const budget = createTestWorkerBudget({ limit: 8 }); let consumerClosed = false, finalized = false;
  const work = runFullCheck({ run: async () => {}, createContext: async () => ({ budget,
    cancel: async () => { cancelled.resolve(); },
    finalize: async () => { assert.equal(consumerClosed, true); assert.equal(budget.summary().activeWorkers, 0); finalized = true; },
  }), verify: async ({ onBuilt, onConsumerReady }) => {
    await onBuilt({ packages: [] }); await onConsumerReady();
    await budget.run({ name: 'consumer', workers: 1 }, async () => {
      entered.resolve(); try { await closed.promise; } finally { consumerClosed = true; }
    });
  }, scriptTests: async () => {}, coverage: ({ workers }) => budget.run({ name: 'coverage', workers }, async () => {
    await entered.promise; throw failure;
  }) });
  const rejected = assert.rejects(work, error => error === failure);
  try { await cancelled.promise; assert.equal(finalized, false); assert.equal(consumerClosed, false); }
  finally { closed.resolve(); await rejected; }
  assert.equal(finalized, true);
});
