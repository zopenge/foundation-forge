import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { runScriptTestSuite } from '../run-script-tests.mjs';

test('each script file retains an independent supervised CLI without an inner console-producing fork', async () => {
  const calls = [];
  await runScriptTestSuite({ budget: { limit: 2, run: async (_spec, task) => task({ workers: 2 }) },
    execute: async spec => { calls.push(spec); } });
  assert.ok(calls.length > 1);
  for (const spec of calls) {
    assert.equal(spec.command, process.execPath); assert.equal(spec.nestedWorkerLimit, 1);
    assert.ok(spec.args.includes('--test')); assert.ok(spec.args.includes('--experimental-test-isolation=none'));
    assert.equal(spec.args.filter(value => value.endsWith('.test.mjs')).length, 1);
    assert.equal(resolve(spec.args.at(-1)), spec.env.FORGE_NODE_TEST_FILE);
  }
});
