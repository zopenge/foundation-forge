import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureTestTemporaryDirectory } from '../test-temporary-directory.mjs';

const binding = { commit: 'a'.repeat(40), source: 'b'.repeat(64), node: 'v24.11.1', workers: 1, run: '42', attempt: '1' };
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

test('CI merge reuses unchanged successful shards from earlier attempts of the same run', async () => {
  const { validateCoverageShards } = await import('../ci-coverage-shards.mjs');
  const current = { ...binding, attempt: '2' };
  assert.deepEqual(validateCoverageShards([part(1), part(2)], current, files), { files, passed: 2, skipped: 0 });
  const replaced = { ...part(2), binding: current };
  assert.deepEqual(validateCoverageShards([part(1), replaced], current, files), { files, passed: 2, skipped: 0 });
});

for (const [name, invalid] of [
  ['future attempt', { attempt: '3' }], ['another run', { run: '43' }],
  ['noncanonical attempt', { attempt: '02' }], ['missing attempt', { attempt: null }],
]) test(`CI reuse rejects ${name}`, async () => {
  const { validateCoverageShards } = await import('../ci-coverage-shards.mjs');
  const current = { ...binding, attempt: '2' };
  assert.throws(() => validateCoverageShards([part(1), { ...part(2), binding: { ...current, ...invalid } }], current, files), /CI_SHARD_/u);
});

test('local CI artifacts retain an explicit local binding and cannot mix with hosted runs', async () => {
  const { validateCoverageShards } = await import('../ci-coverage-shards.mjs');
  const local = { ...binding, run: null, attempt: null };
  const parts = [part(1), part(2)].map(value => ({ ...value, binding: local }));
  assert.deepEqual(validateCoverageShards(parts, local, files), { files, passed: 2, skipped: 0 });
  assert.throws(() => validateCoverageShards(parts, binding, files), /CI_SHARD_/u);
});

for (const [name, change] of [
  ['missing shard', parts => parts.pop()],
  ['duplicate shard', parts => { parts[1] = part(1); }],
  ['different source', parts => { parts[1].binding = { ...binding, commit: 'd'.repeat(40) }; }],
  ['different Node patch', parts => { parts[1].binding = { ...binding, node: 'v24.11.2' }; }],
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
  const base = await ensureTestTemporaryDirectory(repositoryRoot, resolve(repositoryRoot, 'tmp/ci-shard-tests'));
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
  await writeFile(resolve(root, 'part-2-attempt-1/blob.json'), 'changed');
  await assert.rejects(readCoverageShardArtifacts({ ...options, binding, expectedFiles: files }), /CI_SHARD_BLOB/u);
});

test('partial reruns keep earlier bytes and select the newest valid artifact for each shard', async t => {
  const { persistCoverageShard, readCoverageShardArtifacts } = await import('../ci-coverage-shards.mjs');
  const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
  const base = await ensureTestTemporaryDirectory(repositoryRoot, resolve(repositoryRoot, 'tmp/ci-shard-tests'));
  const root = await mkdtemp(resolve(base, 'retry-')), owned = await lstat(root);
  t.after(async () => {
    const current = await lstat(root);
    if (current.isSymbolicLink() || current.dev !== owned.dev || current.ino !== owned.ino) throw new Error('CI_FIXTURE_IDENTITY_CHANGED');
    await rm(root, { recursive: true, force: true });
  });
  const options = { repositoryRoot, directory: root };
  await persistCoverageShard({ ...options, part: part(1), blob: Buffer.from('first') });
  await persistCoverageShard({ ...options, part: part(2), blob: Buffer.from('older') });
  const current = { ...binding, attempt: '2' };
  await persistCoverageShard({ ...options, part: { ...part(2), binding: current }, blob: Buffer.from('newest') });
  const result = await readCoverageShardArtifacts({ ...options, binding: current, expectedFiles: files });
  assert.deepEqual(result.expected, { files, passed: 2, skipped: 0 });
  assert.deepEqual(result.blobs.map(value => value.bytes.toString()).sort(), ['first', 'newest']);
  const contents = await Promise.all((await readdir(root)).map(async name => ({ name, bytes: await readFile(resolve(root, name, 'blob.json'), 'utf8') })));
  assert.deepEqual(contents.map(value => value.bytes).sort(), ['first', 'newest', 'older']);
  const previous = contents.find(value => value.bytes === 'older');
  await writeFile(resolve(root, previous.name, 'blob.json'), 'corrupt');
  await assert.rejects(readCoverageShardArtifacts({ ...options, binding: current, expectedFiles: files }), /CI_SHARD_BLOB/u);
});
