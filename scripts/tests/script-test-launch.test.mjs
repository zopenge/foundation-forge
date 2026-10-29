import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import test from 'node:test';
import { runScriptTestSuite } from '../run-script-tests.mjs';

test('the supervised batch keeps every discovered script file under one continuous lease', async () => {
  const calls = [];
  await runScriptTestSuite({ budget: { limit: 2, run: async (_spec, task) => task({ workers: 2 }) },
    execute: async spec => { calls.push(spec); } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath); assert.equal(calls[0].nestedWorkerLimit, 1);
  assert.match(calls[0].args[0], /run-script-test-worker\.mjs$/u);
  assert.ok(calls[0].args.filter(value => value.endsWith('.test.mjs')).length > 1);
});

test('batch children retain isolated hidden CLIs and stop at the first failure', async () => {
  const { runScriptFiles } = await import('../run-script-test-worker.mjs');
  const files = ['script-test-launch.test.mjs', 'test-worker-budget.test.mjs', 'spawn-options.test.mjs'].map(name => resolve('scripts/tests', name));
  const calls = [];
  await assert.rejects(runScriptFiles(files, { env: {}, spawnCommand: (command, args, options) => {
    calls.push({ command, args, options }); const child = new EventEmitter();
    globalThis.queueMicrotask(() => child.emit('close', calls.length === 2 ? 1 : 0, null)); return child;
  } }), /test-worker-budget\.test\.mjs/u);
  assert.equal(calls.length, 2);
  for (const [index, call] of calls.entries()) {
    assert.equal(call.command, process.execPath); assert.equal(call.options.windowsHide, true); assert.equal(call.options.shell, false);
    assert.equal(call.options.env.FORGE_NODE_TEST_FILE, files[index]);
    assert.ok(call.args.includes('--experimental-test-isolation=none'));
    assert.equal(call.args.filter(value => value.endsWith('.test.mjs')).length, 1);
  }
});

test('batch cancellation after a child closes prevents the next file from starting', async () => {
  const { runScriptFiles } = await import('../run-script-test-worker.mjs');
  const controller = new globalThis.AbortController(), failure = new Error('cancel batch'); let started = 0;
  await assert.rejects(runScriptFiles(['script-test-launch.test.mjs', 'test-worker-budget.test.mjs'].map(name => resolve('scripts/tests', name)), {
    env: {}, signal: controller.signal, spawnCommand: () => {
      started++; const child = new EventEmitter(); globalThis.queueMicrotask(() => { controller.abort(failure); child.emit('close', 0, null); }); return child;
    },
  }), error => error === failure);
  assert.equal(started, 1);
});
