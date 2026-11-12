import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

test('explicit full ordering prioritizes a small expensive file over a large cheap file on a cold cache', async () => {
  const { default: Sequencer } = await import('../vitest-shard-sequencer.mjs');
  const project = { name: 'workspace', config: { sequence: { groupOrder: 0 }, isolate: true } };
  const files = ['large-cheap', 'small-expensive', 'medium'].map(name => ({ project, moduleId: resolve('tmp', `${name}.test.ts`) }));
  const sizes = new Map(files.map((value, index) => [value.moduleId, [100_000, 100, 1_000][index]]));
  const context = { config: { root: resolve('tmp'), provide: { forgeCoverageFullOrder: true,
    forgeCoverageShardWeights: { [files[1].moduleId]: 900, [files[2].moduleId]: 50 } } },
    cache: { getFileTestResults: () => undefined,
      getFileStats: key => ({ size: [...sizes].find(([path]) => key.endsWith(path.split(/[/\\]/u).at(-1)))[1] }) } };
  const sequencer = new Sequencer(context);
  const ordered = await sequencer.sort(files);
  assert.deepEqual(ordered, [files[1], files[2], files[0]]);
  assert.equal(ordered[0], files[1]); assert.equal(ordered[1], files[2]); assert.equal(ordered[2], files[0]);
  assert.deepEqual(files.map(value => value.moduleId), ['large-cheap', 'small-expensive', 'medium'].map(name => resolve('tmp', `${name}.test.ts`)));
  context.config.provide.forgeCoverageFullOrder = false;
  assert.deepEqual(await sequencer.sort(files), [files[0], files[2], files[1]]);
});

test('full ordering refuses duplicate specifications and unbound or invalid hints', async () => {
  const { default: Sequencer } = await import('../vitest-shard-sequencer.mjs');
  const project = { name: 'workspace', config: { sequence: { groupOrder: 0 }, isolate: true } };
  const files = ['one', 'two'].map(name => ({ project, moduleId: resolve('tmp', `${name}.test.ts`) }));
  const context = { config: { root: resolve('tmp'), provide: { forgeCoverageFullOrder: true, forgeCoverageShardWeights: {} } },
    cache: { getFileTestResults: () => undefined, getFileStats: () => undefined } };
  const sequencer = new Sequencer(context);
  await assert.rejects(sequencer.sort([...files, files[0]]), /FULL_COVERAGE_WEIGHT_INVALID/u);
  for (const hints of [{ [resolve('tmp/missing.test.ts')]: 1 }, ...[0, -1, Infinity, '1'].map(weight => ({ [files[0].moduleId]: weight }))]) {
    context.config.provide.forgeCoverageShardWeights = hints;
    await assert.rejects(sequencer.sort(files), /FULL_COVERAGE_WEIGHT_INVALID/u);
  }
});

test('CI shard scheduling separates known expensive files and retains every file exactly once', async () => {
  const { balanceCoverageShards } = await import('../vitest-shard-sequencer.mjs');
  const files = ['heavy', 'medium', 'small-a', 'small-b'].map(name => ({ moduleId: resolve('tmp', `${name}.test.ts`) }));
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
  const files = ['one', 'two'].map(name => ({ moduleId: resolve('tmp', `${name}.test.ts`) }));
  assert.throws(() => balanceCoverageShards([...files, files[0]], {}, 2), /CI_SHARD_/u);
  assert.throws(() => balanceCoverageShards(files, { [resolve('tmp/missing.test.ts')]: 1 }, 2), /CI_SHARD_/u);
  for (const weight of [0, -1, Infinity, '1']) assert.throws(() => balanceCoverageShards(files, { [files[0].moduleId]: weight }, 2), /CI_SHARD_/u);
  assert.throws(() => balanceCoverageShards(files, {}, 3), /CI_SHARD_/u);
});
