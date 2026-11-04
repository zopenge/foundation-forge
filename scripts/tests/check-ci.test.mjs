import assert from 'node:assert/strict';
import test from 'node:test';

test('CI entry explicitly distinguishes partial shards from report merging', async () => {
  const { parseCiCheckArguments } = await import('../check-ci.mjs');
  assert.deepEqual(parseCiCheckArguments(['--shard', '1/2']), { kind: 'shard', shard: '1/2' });
  assert.deepEqual(parseCiCheckArguments(['--merge', '.tmp/ci-shards']), { kind: 'merge', directory: '.tmp/ci-shards' });
  for (const args of [[], ['--full'], ['--shard'], ['--shard', '0/2'], ['--merge'],
    ['--merge', '--shard'], ['--shard', '1/2', '--full']]) assert.throws(() => parseCiCheckArguments(args), /CI_/u);
});

test('CI can run common gates once and explicitly partial coverage on independent workers', async () => {
  const { parseCiCheckArguments } = await import('../check-ci.mjs');
  assert.deepEqual(parseCiCheckArguments(['--gates']), { kind: 'gates' });
  assert.deepEqual(parseCiCheckArguments(['--coverage-shard', '3/8']), { kind: 'coverage-shard', shard: '3/8' });
  for (const args of [['--gates', 'extra'], ['--coverage-shard'], ['--coverage-shard', '9/8']])
    assert.throws(() => parseCiCheckArguments(args), /CI_/u);
});
