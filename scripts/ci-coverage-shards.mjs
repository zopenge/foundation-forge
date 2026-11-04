import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ensureTestTemporaryDirectory } from './test-temporary-directory.mjs';

const fail = reason => { throw new Error(`CI_SHARD_${reason}`); };
const count = value => Number.isSafeInteger(value) && value >= 0;
const filename = value => typeof value === 'string' && !/[\\:\0]/u.test(value)
  && value.split('/').every(part => part && part !== '.' && part !== '..');

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
    if (part?.schemaVersion !== 1 || part.kind !== 'ci-coverage-shard'
      || !isDeepStrictEqual(part.binding, binding) || part.shard?.count !== parts.length
      || !count(part.shard.index) || part.shard.index < 1 || part.shard.index > parts.length
      || indexes.has(part.shard.index) || !Array.isArray(part.files) || !part.files.length
      || !part.files.every(filename) || !count(part.passed) || !count(part.skipped)
      || !/^[a-f0-9]{64}$/u.test(part.blobSha256 ?? '')) fail('INVALID');
    assertCoverageShardAudit(part.audit, binding.workers);
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
  assertCoverageShardAudit(part.audit, part.binding.workers);
  const root = await ensureTestTemporaryDirectory(repositoryRoot, directory);
  const target = resolve(root, `part-${shard.index}`);
  await mkdir(target); // 不覆盖上一次或其他作业的结果。
  await writeFile(resolve(target, 'blob.json'), blob, { flag: 'wx' });
  await writeFile(resolve(target, 'manifest.json'), `${JSON.stringify({ ...part, blobSha256: digest(blob) }, null, 2)}\n`, { flag: 'wx' });
}

export async function readCoverageShardArtifacts({ repositoryRoot, directory, binding, expectedFiles }) {
  await lstat(directory);
  const root = await ensureTestTemporaryDirectory(repositoryRoot, directory), parts = [], blobs = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!/^part-[1-8]$/u.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) fail('ARTIFACT');
    const target = await ensureTestTemporaryDirectory(repositoryRoot, resolve(root, entry.name));
    const part = JSON.parse((await readBounded(resolve(target, 'manifest.json'), 2 * 1024 * 1024)).toString('utf8'));
    const bytes = await readBounded(resolve(target, 'blob.json'), 64 * 1024 * 1024);
    if (`part-${part.shard?.index}` !== entry.name || digest(bytes) !== part.blobSha256) fail('BLOB');
    parts.push(part); blobs.push({ name: `${entry.name}.json`, bytes });
  }
  return { expected: validateCoverageShards(parts, binding, expectedFiles), blobs };
}
