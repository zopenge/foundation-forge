import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runScriptTestSuite } from '../run-script-tests.mjs';
import { createTestWorkerBudget } from '../test-worker-budget.mjs';

const gate = () => { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; };
const fixtures = ['scripts/tests/test-worker-budget.test.mjs', 'scripts/tests/spawn-options.test.mjs',
  'scripts/tests/script-test-launch.test.mjs', 'scripts/tests/script-test-sharding.test.mjs', 'scripts/tests/quick-check.test.mjs'];

test('script groups reserve both parent and nested slots and cover selected files exactly once', async () => {
  const calls = [], reservations = [];
  await runScriptTestSuite({ budget: { limit: 8, run: async (spec, task) => {
    reservations.push(spec.workers); return task({ workers: spec.workers });
  } }, execute: async spec => { calls.push(spec); } }, { files: fixtures });
  assert.equal(calls.length, 4); assert.deepEqual(reservations, [2, 2, 2, 2]);
  const files = calls.flatMap(value => value.args.slice(1));
  assert.deepEqual([...files].sort(), fixtures.map(value => fileURLToPath(new URL(`../../${value}`, import.meta.url))).sort());
  assert.equal(new Set(files).size, fixtures.length);
  for (const call of calls) { assert.equal(call.nestedWorkerLimit, 1); assert.ok(call.args.length > 1); }
});

test('one actual worker keeps the existing single supervised script group', async () => {
  const calls = [], reservations = [];
  await runScriptTestSuite({ budget: { limit: 1, run: async (spec, task) => {
    reservations.push(spec.workers); return task({ workers: spec.workers });
  } }, execute: async spec => { calls.push(spec); } }, { files: fixtures });
  assert.deepEqual(reservations, [1]); assert.equal(calls.length, 1); assert.equal(calls[0].args.length, fixtures.length + 1);
});

test('a failed group cancels siblings and waits for their owned cleanup before rejecting', async () => {
  const closed = gate(), launched = gate(), failure = new Error('script group failed'), seen = [];
  let cancelled = false, settled = false;
  const work = runScriptTestSuite({ budget: { limit: 8, run: async (spec, task) => task({ workers: spec.workers }) },
    cancel: async error => { assert.equal(error, failure); cancelled = true; await closed.promise; },
    execute: async spec => { seen.push(spec); if (seen.length === 1) { launched.resolve(); throw failure; } await closed.promise; },
  }, { files: fixtures }).finally(() => { settled = true; });
  const rejected = assert.rejects(work, error => error === failure);
  await launched.promise; await setImmediate(); assert.equal(cancelled, true); assert.equal(settled, false);
  closed.resolve(); await rejected; assert.equal(settled, true);
});

test('script group failure retains a secondary cancellation cleanup failure', async () => {
  const failure = new Error('first script failure'), cleanup = new Error('sibling cleanup failed');
  await assert.rejects(runScriptTestSuite({ budget: { limit: 4, run: async (spec, task) => task({ workers: spec.workers }) },
    cancel: async () => { throw cleanup; }, execute: async () => { throw failure; },
  }, { files: fixtures }), error => error instanceof AggregateError && error.cause === failure && error.errors.includes(cleanup));
});

test('the shared budget prevents queued groups from starting after the first failure', async () => {
  // 缩小虚拟执行容量，让其余分组排队；不启动任何真实子进程。
  const budget = createTestWorkerBudget({ limit: 2 }), failure = new Error('queued group stopped'); let started = 0;
  await assert.rejects(runScriptTestSuite({ budget: { ...budget, limit: 8 }, cancel: async () => {},
    execute: async () => { started++; throw failure; },
  }, { files: fixtures }), error => error === failure);
  assert.equal(started, 1); assert.equal(budget.summary().activeWorkers, 0);
});
