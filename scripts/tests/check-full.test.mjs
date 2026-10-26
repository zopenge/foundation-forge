import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers';
import test from 'node:test';
import { runFullCheck } from '../check-full.mjs';
import { createTestWorkerBudget } from '../test-worker-budget.mjs';

const pending = () => {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
};
const turn = () => new Promise(accept => setImmediate(accept));

test('full heavy stages wait for lint, packing and consumers before types, scripts and coverage', async () => {
  const phases = ['lint', 'build', 'packing', 'consumers', 'typecheck:built', 'packages:check-cycles:built', 'test:scripts', 'test:coverage'];
  const gates = Object.fromEntries(phases.map(name => [name, pending()])), calls = [];
  let created = 0, finalized = 0, consumerContext;
  const context = { budget: createTestWorkerBudget({ limit: 2 }), finalize: async () => {
    finalized++; assert.equal(context.budget.summary().activeWorkers, 0);
  } };
  const phase = async name => { calls.push(name); await gates[name].promise; };
  const work = runFullCheck({ run: phase,
    createContext: async () => { created++; return context; },
    verify: async ({ onBuilt }) => {
      calls.push('pack:check'); await gates.build.promise;
      consumerContext = await onBuilt({ packages: [] });
      await gates.packing.promise; calls.push('consumers');
      await Promise.all([1, 2].map(index => context.budget.run({ name: `consumer-${index}`, workers: 1 }, () => gates.consumers.promise)));
    },
    scriptTests: value => { assert.equal(value, consumerContext); return value.budget.run({ name: 'scripts', workers: 2 }, () => phase('test:scripts')); },
    coverage: ({ context: value }) => { assert.equal(value, consumerContext); return value.budget.run({ name: 'coverage', workers: 2 }, () => phase('test:coverage')); },
  });
  try {
    assert.deepEqual(calls, ['lint']);
    gates.lint.resolve(); await turn(); assert.deepEqual(calls, ['lint', 'pack:check']); assert.equal(created, 0);
    gates.build.resolve(); await turn(); assert.equal(created, 1); assert.deepEqual(calls, ['lint', 'pack:check']);
    gates.packing.resolve(); await turn(); assert.deepEqual(calls, ['lint', 'pack:check', 'consumers']);
    assert.equal(context.budget.summary().activeWorkers, 2);
    gates.consumers.resolve(); await turn(); assert.equal(calls.at(-1), 'typecheck:built');
    assert.equal(context.budget.summary().activeWorkers, 0);
    for (const [name, next] of [['typecheck:built', 'packages:check-cycles:built'], ['packages:check-cycles:built', 'test:scripts'], ['test:scripts', 'test:coverage']]) {
      gates[name].resolve(); await turn(); assert.equal(calls.at(-1), next);
    }
    gates['test:coverage'].resolve(); await work;
    assert.equal(created, 1); assert.equal(finalized, 1); assert.equal(context.budget.summary().peakWorkers, 2);
  } finally { for (const gate of Object.values(gates)) gate.resolve(); await Promise.allSettled([work]); }
});

test('full stage failures stop later stages and finalize the created context once', async t => {
  const order = ['lint', 'pack:check', 'consumers', 'typecheck:built', 'packages:check-cycles:built', 'test:scripts', 'test:coverage'];
  for (const failed of order) await t.test(failed, async () => {
    const calls = [], failure = new Error(`failed ${failed}`); let finalized = 0, stopped;
    const context = { budget: { stop: error => { stopped = error; } }, finalize: async () => { finalized++; } };
    const phase = async name => { calls.push(name); if (name === failed) throw failure; };
    await assert.rejects(runFullCheck({ run: phase, createContext: async () => context,
      verify: async ({ onBuilt }) => { await phase('pack:check'); await onBuilt({ packages: [] }); await phase('consumers'); },
      scriptTests: () => phase('test:scripts'), coverage: () => phase('test:coverage'),
    }), error => error === failure);
    assert.deepEqual(calls, order.slice(0, order.indexOf(failed) + 1));
    assert.equal(finalized, order.indexOf(failed) > 1 ? 1 : 0);
    if (finalized) assert.equal(stopped, failure);
  });
});

test('full check waits for failed consumer siblings to drain before finalizing', async () => {
  const finish = pending(), failure = new Error('consumer failed'), calls = [];
  let siblingClosed = false, finalized = false;
  const context = { budget: createTestWorkerBudget({ limit: 2 }), finalize: async () => {
    finalized = true; assert.equal(siblingClosed, true); assert.equal(context.budget.summary().activeWorkers, 0);
  } };
  const work = runFullCheck({ run: async name => { calls.push(name); }, createContext: async () => context,
    verify: async ({ onBuilt }) => {
      await onBuilt({ packages: [] });
      await Promise.allSettled([
        context.budget.run({ name: 'failed import', workers: 1 }, async () => { await Promise.resolve(); throw failure; }),
        context.budget.run({ name: 'smoke sibling', workers: 1 }, async () => { await finish.promise; siblingClosed = true; }),
      ]);
      throw failure;
    }, scriptTests: async () => { calls.push('scripts'); }, coverage: async () => { calls.push('coverage'); },
  });
  const rejected = assert.rejects(work, error => error === failure);
  try { await turn(); assert.equal(finalized, false); assert.deepEqual(calls, ['lint']); }
  finally { finish.resolve(); await rejected; }
  assert.equal(finalized, true); assert.deepEqual(calls, ['lint']);
});

test('full check preserves its primary failure if the final context audit also fails', async () => {
  const primary = new Error('typecheck failed'), audit = new Error('audit failed'); let finalized = 0;
  await assert.rejects(runFullCheck({ run: async name => { if (name === 'typecheck:built') throw primary; },
    createContext: async () => ({ budget: { stop() {} }, finalize: async () => { finalized++; throw audit; } }),
    verify: async ({ onBuilt }) => { await onBuilt({ packages: [] }); }, scriptTests: async () => {}, coverage: async () => {},
  }), error => error instanceof AggregateError && error.errors.includes(primary) && error.errors.includes(audit));
  assert.equal(finalized, 1);
});
