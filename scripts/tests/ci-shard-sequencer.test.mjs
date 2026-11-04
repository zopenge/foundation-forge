import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

test('CI shard scheduling separates known expensive files and retains every file exactly once', async () => {
  const { balanceCoverageShards } = await import('../vitest-shard-sequencer.mjs');
  const files = ['heavy', 'medium', 'small-a', 'small-b'].map(name => ({ moduleId: resolve('.tmp', `${name}.test.ts`) }));
  const weights = { [files[0].moduleId]: 900, [files[1].moduleId]: 350 };
  const parts = balanceCoverageShards(files, weights, 2);
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0], [files[0]]);
  assert.deepEqual(parts[1], files.slice(1));
  assert.deepEqual(parts.flat().map(value => value.moduleId).sort(), files.map(value => value.moduleId).sort());
  assert.deepEqual(balanceCoverageShards([...files].reverse(), weights, 2), parts);
});

test('CI shard hints cannot omit, duplicate, invent or invalidate a test specification', async () => {
  const { balanceCoverageShards } = await import('../vitest-shard-sequencer.mjs');
  const files = ['one', 'two'].map(name => ({ moduleId: resolve('.tmp', `${name}.test.ts`) }));
  assert.throws(() => balanceCoverageShards([...files, files[0]], {}, 2), /CI_SHARD_/u);
  assert.throws(() => balanceCoverageShards(files, { [resolve('.tmp/missing.test.ts')]: 1 }, 2), /CI_SHARD_/u);
  for (const weight of [0, -1, Infinity, '1']) assert.throws(() => balanceCoverageShards(files, { [files[0].moduleId]: weight }, 2), /CI_SHARD_/u);
  assert.throws(() => balanceCoverageShards(files, {}, 3), /CI_SHARD_/u);
});
