import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ensureTestTemporaryDirectory } from './test-temporary-directory.mjs';

const fail = reason => { throw new Error(`CI_SHARD_${reason}`); };
const count = value => Number.isSafeInteger(value) && value >= 0;
const filename = value => typeof value === 'string' && !/[\\:\0]/u.test(value)
  && value.split('/').every(part => part && part !== '.' && part !== '..');

const attemptNumber = value => {
  if (value === null) return 0;
  if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(Number(value))) fail('INVALID');
  return Number(value);
};

export function coverageShardDirectoryName(index, attempt) {
  if (!Number.isInteger(index) || index < 1 || index > 8) fail('INVALID');
  return `part-${index}-attempt-${attemptNumber(attempt) === 0 ? 'local' : attempt}`;
}

function assertBinding(observed, expected) {
  if (!observed || !expected) fail('INVALID');
  const { attempt: observedAttempt, ...observedIdentity } = observed;
  const { attempt: expectedAttempt, ...expectedIdentity } = expected;
  const previous = attemptNumber(observedAttempt), current = attemptNumber(expectedAttempt);
  for (const [identity, attempt] of [[observedIdentity, previous], [expectedIdentity, current]]) {
    if (attempt === 0 ? identity.run !== null : typeof identity.run !== 'string' || !/^[1-9]\d*$/u.test(identity.run)) fail('INVALID');
  }
  if (previous > current || !isDeepStrictEqual(observedIdentity, expectedIdentity)) fail('INVALID');
  return previous;
}

function assertPart(part, binding) {
  if (part?.schemaVersion !== 1 || part.kind !== 'ci-coverage-shard'
    || !count(part.shard?.count) || part.shard.count < 2 || part.shard.count > 8
    || !count(part.shard.index) || part.shard.index < 1 || part.shard.index > part.shard.count
    || !Array.isArray(part.files) || !part.files.length || !part.files.every(filename)
    || new Set(part.files).size !== part.files.length || !count(part.passed) || !count(part.skipped)
    || !/^[a-f0-9]{64}$/u.test(part.blobSha256 ?? '')) fail('INVALID');
  const attempt = assertBinding(part.binding, binding);
  assertCoverageShardAudit(part.audit, binding.workers);
  return attempt;
}

export function parseCoverageShard(value) {
  const matched = typeof value === 'string' && /^([1-8])\/([2-8])$/u.exec(value);
  if (!matched || Number(matched[1]) > Number(matched[2])) fail('ARGUMENT');
  return { index: Number(matched[1]), count: Number(matched[2]) };
}

export function assertCoverageShardAudit(audit, workers) {
  if (!audit || !['limit', 'activeWorkers', 'peakWorkers', 'started', 'finished', 'observedWorkerLimit', 'observedPeakWorkers']
    .every(key => count(audit[key])) || audit.limit !== workers || audit.activeWorkers !== 0
    || audit.started === 0 || audit.started !== audit.finished || audit.failed !== false
    || audit.peakWorkers > audit.limit || audit.observedPeakWorkers > audit.observedWorkerLimit
    || audit.observedWorkerLimit < audit.limit || !Array.isArray(audit.remainingWorkers) || audit.remainingWorkers.length) fail('AUDIT');
}

/** 分片只能合成完整CI证据，不能成为发布准入所需的full收据。 */
export function validateCoverageShards(parts, binding, expectedFiles) {
  if (!Array.isArray(parts) || parts.length < 2 || parts.length > 8) fail('INCOMPLETE');
  const indexes = new Set(), files = [], result = { files, passed: 0, skipped: 0 };
  for (const part of parts) {
    assertPart(part, binding);
    if (part.shard.count !== parts.length || indexes.has(part.shard.index)) fail('INVALID');
    indexes.add(part.shard.index); files.push(...part.files);
    result.passed += part.passed; result.skipped += part.skipped;
  }
  files.sort();
  if (new Set(files).size !== files.length || !isDeepStrictEqual(files, [...expectedFiles].sort())) fail('FILES');
  return result;
}

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const readBounded = async (path, limit) => {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size > limit) fail('ARTIFACT');
  const bytes = await readFile(path);
  if (bytes.length > limit) fail('ARTIFACT');
  return bytes;
};

export async function persistCoverageShard({ repositoryRoot, directory, part, blob }) {
  const shard = parseCoverageShard(`${part.shard?.index}/${part.shard?.count}`);
  if (part.schemaVersion !== 1 || part.kind !== 'ci-coverage-shard') fail('INVALID');
  assertBinding(part.binding, part.binding);
  assertCoverageShardAudit(part.audit, part.binding.workers);
  const root = await ensureTestTemporaryDirectory(repositoryRoot, directory);
  const target = resolve(root, coverageShardDirectoryName(shard.index, part.binding?.attempt));
  await mkdir(target); // 不覆盖上一次或其他作业的结果。
  await writeFile(resolve(target, 'blob.json'), blob, { flag: 'wx' });
  await writeFile(resolve(target, 'manifest.json'), `${JSON.stringify({ ...part, blobSha256: digest(blob) }, null, 2)}\n`, { flag: 'wx' });
}

export async function readCoverageShardArtifacts({ repositoryRoot, directory, binding, expectedFiles }) {
  await lstat(directory);
  const root = await ensureTestTemporaryDirectory(repositoryRoot, directory), selected = new Map(), expected = new Set(expectedFiles);
  let shardCount;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!/^part-[1-8]-attempt-(?:local|[1-9]\d*)$/u.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) fail('ARTIFACT');
    const target = await ensureTestTemporaryDirectory(repositoryRoot, resolve(root, entry.name));
    const part = JSON.parse((await readBounded(resolve(target, 'manifest.json'), 2 * 1024 * 1024)).toString('utf8'));
    const attempt = assertPart(part, binding);
    if (shardCount !== undefined && shardCount !== part.shard.count) fail('INVALID');
    shardCount = part.shard.count;
    if (part.files.some(file => !expected.has(file))) fail('FILES');
    const bytes = await readBounded(resolve(target, 'blob.json'), 64 * 1024 * 1024);
    if (coverageShardDirectoryName(part.shard.index, part.binding.attempt) !== entry.name || digest(bytes) !== part.blobSha256) fail('BLOB');
    const previous = selected.get(part.shard.index);
    if (previous?.attempt === attempt) fail('INVALID');
    if (!previous || attempt > previous.attempt) selected.set(part.shard.index, { part, attempt, name: `${entry.name}.json`, bytes });
  }
  const entries = [...selected.values()].sort((left, right) => left.part.shard.index - right.part.shard.index);
  return { expected: validateCoverageShards(entries.map(value => value.part), binding, expectedFiles),
    blobs: entries.map(({ name, bytes }) => ({ name, bytes })) };
}
