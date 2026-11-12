import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { createTestTaskScope } from '../test-task-scope.mjs';

test('外层停止等待后仍先排空测试主体的后续工作，再允许夹具回收', async () => {
  const scope = createTestTaskScope(), gate = Promise.withResolvers();
  const calls = [];
  void scope.run(async () => { calls.push('started'); await gate.promise; calls.push('last assertion'); });
  let disposed = false;
  const cleanup = scope.drain().then(errors => { assert.deepEqual(errors, []); disposed = true; });
  try {
    await setImmediate(); assert.deepEqual(calls, ['started']); assert.equal(disposed, false);
  } finally { gate.resolve(); await cleanup; }
  assert.deepEqual(calls, ['started', 'last assertion']); assert.equal(disposed, true);
});

test('排空保留所有晚到失败，包括undefined，重复排空不重复上报', async () => {
  const scope = createTestTaskScope(), failure = new Error('late failure');
  void scope.run(async () => { throw failure; });
  void scope.run(async () => { throw undefined; });
  assert.deepEqual(await scope.drain(), [failure, undefined]);
  assert.deepEqual(await scope.drain(), []);
});

test('排空期间追加的任务也必须结束', async () => {
  const scope = createTestTaskScope(), gate = Promise.withResolvers();
  let completed = false;
  void scope.run(async () => { void scope.run(async () => { await gate.promise; completed = true; }); });
  const drain = scope.drain();
  try { await setImmediate(); assert.equal(completed, false); }
  finally { gate.resolve(); await drain; }
  assert.equal(completed, true);
});
