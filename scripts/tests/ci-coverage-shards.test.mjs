import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureTestTemporaryDirectory } from '../test-temporary-directory.mjs';

const binding = { commit: 'a'.repeat(40), source: 'b'.repeat(64), node: 'v24.11.1', workers: 1 };
const audit = { limit: 1, activeWorkers: 0, peakWorkers: 1, started: 3, finished: 3,
  failed: false, observedWorkerLimit: 2, observedPeakWorkers: 2, remainingWorkers: [] };
const part = index => ({ schemaVersion: 1, kind: 'ci-coverage-shard', shard: { index, count: 2 }, binding,
  files: [`packages/p/tests/${index}.test.ts`], passed: 1, skipped: 0, blobSha256: 'c'.repeat(64), audit });
const files = [part(1).files[0], part(2).files[0]];

test('CI shard arguments reject omitted, zero, duplicate separators and unbounded shard counts', async () => {
  const { parseCoverageShard } = await import('../ci-coverage-shards.mjs');
  assert.deepEqual(parseCoverageShard('1/2'), { index: 1, count: 2 });
  assert.deepEqual(parseCoverageShard('2/2'), { index: 2, count: 2 });
  for (const value of [undefined, '', '0/2', '3/2', '1/1', '1/9', '1/2/3', '01/2', '1.5/2']) {
    assert.throws(() => parseCoverageShard(value), /CI_SHARD_ARGUMENT/u);
  }
});

test('complete CI shard evidence covers each current test file exactly once and remains partial', async () => {
  const { validateCoverageShards } = await import('../ci-coverage-shards.mjs');
  assert.deepEqual(validateCoverageShards([part(2), part(1)], binding, files), { files, passed: 2, skipped: 0 });
});

for (const [name, change] of [
  ['missing shard', parts => parts.pop()],
  ['duplicate shard', parts => { parts[1] = part(1); }],
  ['different source', parts => { parts[1].binding = { ...binding, commit: 'd'.repeat(40) }; }],
  ['different shard count', parts => { parts[1].shard.count = 3; }],
  ['duplicate test file', parts => { parts[1].files = [...parts[0].files]; }],
  ['missing test file', parts => { parts[1].files = []; }],
  ['unexpected test file', parts => { parts[1].files = ['packages/p/tests/foreign.test.ts']; }],
  ['absolute path', parts => { parts[1].files = ['/outside/test.ts']; }],
  ['escaping path', parts => { parts[1].files = ['../outside/test.ts']; }],
  ['active worker', parts => { parts[1].audit.activeWorkers = 1; }],
  ['failed worker', parts => { parts[1].audit.failed = true; }],
  ['unclosed worker', parts => { parts[1].audit.remainingWorkers = [{ pid: 123 }]; }],
  ['unfinished reservation', parts => { parts[1].audit.finished--; }],
  ['excess worker peak', parts => { parts[1].audit.peakWorkers = 2; }],
  ['excess observed peak', parts => { parts[1].audit.observedPeakWorkers = 3; }],
  ['invalid test count', parts => { parts[1].passed = -1; }],
  ['non-shard receipt', parts => { parts[1].kind = 'full'; }],
  ['invalid blob digest', parts => { parts[1].blobSha256 = ''; }],
]) test(`CI shard merge rejects ${name}`, async () => {
  const { validateCoverageShards } = await import('../ci-coverage-shards.mjs');
  const parts = globalThis.structuredClone([part(1), part(2)]);
  change(parts);
  assert.throws(() => validateCoverageShards(parts, binding, files), /CI_SHARD_/u);
});

test('CI artifacts reject changed blob bytes and never overwrite a previous shard', async t => {
  const { persistCoverageShard, readCoverageShardArtifacts } = await import('../ci-coverage-shards.mjs');
  assert.equal(typeof persistCoverageShard, 'function');
  const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
  const base = await ensureTestTemporaryDirectory(repositoryRoot, resolve(repositoryRoot, '.tmp/ci-shard-tests'));
  const root = await mkdtemp(resolve(base, 'io-')), owned = await lstat(root);
  t.after(async () => {
    const current = await lstat(root);
    if (current.isSymbolicLink() || current.dev !== owned.dev || current.ino !== owned.ino) throw new Error('CI_FIXTURE_IDENTITY_CHANGED');
    await rm(root, { recursive: true, force: true });
  });
  const options = { repositoryRoot, directory: root };
  for (const index of [1, 2]) await persistCoverageShard({ ...options, part: part(index), blob: Buffer.from(`fixture-${index}`) });
  const result = await readCoverageShardArtifacts({ ...options, binding, expectedFiles: files });
  assert.equal(result.expected.passed, 2);
  assert.equal(result.blobs.length, 2);
  await assert.rejects(persistCoverageShard({ ...options, part: part(1), blob: Buffer.from('replacement') }), { code: 'EEXIST' });
  await writeFile(resolve(root, 'part-2/blob.json'), 'changed');
  await assert.rejects(readCoverageShardArtifacts({ ...options, binding, expectedFiles: files }), /CI_SHARD_BLOB/u);
});
