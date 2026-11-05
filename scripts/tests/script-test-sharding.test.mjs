import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as scriptTests from '../run-script-tests.mjs';
import { createTestWorkerBudget } from '../test-worker-budget.mjs';

const { runScriptTestSuite } = scriptTests;
const groupScriptTestFiles = (...args) => scriptTests.groupScriptTestFiles(...args);

const gate = () => { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; };
const fixtures = ['scripts/tests/test-worker-budget.test.mjs', 'scripts/tests/spawn-options.test.mjs',
  'scripts/tests/script-test-launch.test.mjs', 'scripts/tests/script-test-sharding.test.mjs', 'scripts/tests/quick-check.test.mjs'];

test('the supervised runner uses measured weights instead of leaving heavy files in one group', async () => {
  const calls = [];
  await runScriptTestSuite({ budget: { limit: 8, run: async (_, task) => task({ workers: 2 }) },
    execute: async spec => { calls.push(spec); } }, { files: fixtures,
    scheduling: { defaultWeight: 0.25, weights: Object.fromEntries(fixtures.map((file, index) => [basename(file), [20, 11, 9, 7, 6][index]])) } });
  assert.deepEqual(calls.map(call => call.args.slice(1).map(file => basename(file))),
    [[basename(fixtures[0])], [basename(fixtures[1])], [basename(fixtures[2])], fixtures.slice(3).map(file => basename(file))]);
});

test('weighted script groups separate expensive files while preserving every file exactly once', () => {
  const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const scheduling = { defaultWeight: 0.25, weights: Object.fromEntries(files.map((file, index) => [file, [20, 11, 9, 7, 6, 4, 3][index]])) };
  const groups = groupScriptTestFiles(files, scheduling, 4);
  assert.deepEqual(groups, [['a'], ['b', 'g'], ['c', 'f'], ['d', 'e']]);
  assert.deepEqual(groups.flat().sort(), files);
  assert.equal(Math.max(...groups.map(group => group.reduce((sum, file) => sum + scheduling.weights[file], 0))), 20);
  assert.deepEqual(files, ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  assert.deepEqual(groupScriptTestFiles(files, scheduling, 1), [files]);
});

test('partial script selections accept bound unselected hints and retain the explicit default', () => {
  const available = ['one', 'two', 'three', 'four'];
  const scheduling = { defaultWeight: 0.25, weights: { one: 3, four: 20 } };
  assert.deepEqual(groupScriptTestFiles(available.slice(0, 3), scheduling, 2, available), [['one'], ['two', 'three']]);
});

test('weighted assignment preserves the original selected order within each group', () => {
  const files = ['cheap', 'heavy', 'medium', 'small'];
  assert.deepEqual(groupScriptTestFiles(files, { defaultWeight: 1, weights: { heavy: 20, medium: 11, small: 10 } }, 2),
    [['cheap', 'heavy'], ['medium', 'small']]);
  assert.deepEqual(groupScriptTestFiles(files, { defaultWeight: 1, weights: {} }, 2), [['cheap', 'medium'], ['heavy', 'small']]);
});

test('script scheduling rejects invalid weights, unbound hints and duplicate or missing files', () => {
  for (const weight of [0, -1, Infinity, '1', null, undefined]) {
    assert.throws(() => groupScriptTestFiles(['one'], { defaultWeight: 1, weights: { one: weight } }, 1), /SCRIPT_TEST_SCHEDULING_INVALID/u);
    assert.throws(() => groupScriptTestFiles(['one'], { defaultWeight: weight, weights: {} }, 1), /SCRIPT_TEST_SCHEDULING_INVALID/u);
  }
  for (const [files, scheduling, count, available] of [
    [[], { defaultWeight: 1, weights: {} }, 1],
    [['one', 'one'], { defaultWeight: 1, weights: {} }, 1],
    [['one'], { defaultWeight: 1, weights: { foreign: 1 } }, 1],
    [['one'], { defaultWeight: 1, weights: {} }, 0],
    [['one'], { defaultWeight: 1, weights: {} }, 2],
    [['one'], { defaultWeight: 1, weights: {} }, 1, ['other']],
    [['one'], { defaultWeight: 1, weights: [] }, 1],
  ]) assert.throws(() => groupScriptTestFiles(files, scheduling, count, available), /SCRIPT_TEST_SCHEDULING_INVALID/u);
});

test('invalid scheduling is rejected before any supervised script group starts', async () => {
  let started = 0;
  for (const scheduling of [null, [], { defaultWeight: 0.25, weights: { '../foreign.test.mjs': 1 } },
    { defaultWeight: 0.25, weights: {}, omittedFiles: true }]) {
    await assert.rejects(runScriptTestSuite({ budget: { limit: 8, run: async () => { started++; } } },
      { files: fixtures, scheduling }), /SCRIPT_TEST_SCHEDULING_INVALID/u);
  }
  assert.equal(started, 0);
});

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
