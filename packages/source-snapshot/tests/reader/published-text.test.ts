import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  buildSourceTextPackage,
  collectSnapshotObjectRequirements,
  createSnapshotManifest,
  createTextSnapshotManifest,
  readSnapshotText,
  stageSourceTextFile,
} from '../../src/index.js';
import type { SnapshotManifest, SnapshotObjectBytes } from '../../src/index.js';

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
const limits = { maxObjectBytes: 1_048_576, maxFileBytes: 16_777_216, maxTotalBytes: 67_108_864 };
const required = <T>(value: T | undefined, label: string): T => {
  if (value === undefined) throw new Error('missing fixture ' + label);
  return value;
};

async function fixture(text = '第一行\r\n第二行🙂') {
  const staged = await stageSourceTextFile({ path: 'src/example.ts', group: 'code', bytes: utf8(text) });
  const packed = await buildSourceTextPackage([staged], {
    targetObjectBytes: 4096, maxObjectBytes: 8192, maxObjectCount: 20, maxObjectBytesTotal: 100_000,
    textFormatVersion: 2,
  });
  const manifest = await createTextSnapshotManifest({
    projectId: 'reader-fixture', policyVersion: '2', publishedAt: 1, repositories: [], textPackage: packed,
  });  const objects = packed.objects.map(object => ({ path: object.path, bytes: utf8(object.content) }));
  return { staged, packed, manifest, objects };
}

test('reads verified normalized text from published object bytes only', async () => {
  const { staged, manifest, objects } = await fixture();
  const requirements = collectSnapshotObjectRequirements(manifest, ['src/example.ts']);
  expect(requirements.map(value => value.path)).toEqual(objects.map(value => value.path));
  const result = await readSnapshotText(manifest, objects, 'src/example.ts', limits);
  expect(result).toMatchObject({
    snapshotId: manifest.snapshotId,
    path: 'src/example.ts',
    text: '第一行\n第二行🙂',
    normalizedSha256: staged.normalizedSha256,
    sourceSha256: staged.sha256,
    assurance: 'normalized-text-verified',
  });
});

test('fails closed for missing, duplicate, corrupted or oversized object bytes', async () => {
  const { manifest, objects } = await fixture();
  await expect(readSnapshotText(manifest, [], 'src/example.ts', limits))
    .rejects.toMatchObject({ code: 'OBJECT_MISSING' });
  const firstObject = required(objects[0], 'packed object');
  await expect(readSnapshotText(manifest, [firstObject, firstObject], 'src/example.ts', limits))
    .rejects.toMatchObject({ code: 'OBJECT_CONFLICT' });
  const corrupted = objects.map(object => ({ ...object, bytes: Uint8Array.from(object.bytes, value => value ^ 1) }));
  await expect(readSnapshotText(manifest, corrupted, 'src/example.ts', limits))
    .rejects.toMatchObject({ code: 'OBJECT_INTEGRITY_MISMATCH' });  await expect(readSnapshotText(manifest, objects, 'src/example.ts', { ...limits, maxObjectBytes: 1 }))
    .rejects.toMatchObject({ code: 'TEXT_READ_LIMIT_EXCEEDED' });
});

test('rejects normalized-text mismatch even when object bytes match their object hashes', async () => {
  const { manifest, objects } = await fixture();
  const sourceFile = required(manifest.files[0], 'manifest file');
  const details = sourceFile.details as Record<string, unknown>;
  const wrongDetails = { ...details, normalizedSha256: '0'.repeat(64) };
  const tampered = await createSnapshotManifest({
    projectId: manifest.projectId,
    policyVersion: manifest.policyVersion,
    publishedAt: manifest.publishedAt,
    repositories: manifest.repositories,
    files: [{ ...sourceFile, details: wrongDetails }],
    objects: manifest.objects,
  });
  await expect(readSnapshotText(tampered, objects, 'src/example.ts', limits))
    .rejects.toMatchObject({ code: 'TEXT_INTEGRITY_MISMATCH' });
});

test('legacy details remain object-verifiable but are unsupported by authenticated text reader', async () => {
  const staged = await stageSourceTextFile({ path: 'src/legacy.ts', group: 'code', bytes: utf8('legacy\n') });
  const packed = await buildSourceTextPackage([staged], {
    targetObjectBytes: 4096, maxObjectBytes: 8192, maxObjectCount: 10, maxObjectBytesTotal: 100_000,
  });
  const manifest = await createTextSnapshotManifest({
    projectId: 'legacy-reader', policyVersion: '1', publishedAt: 1, repositories: [], textPackage: packed,
  });  const objects: SnapshotObjectBytes[] = packed.objects.map(object => ({ path: object.path, bytes: utf8(object.content) }));
  await expect(readSnapshotText(manifest, objects, 'src/legacy.ts', limits))
    .rejects.toMatchObject({ code: 'TEXT_FORMAT_UNSUPPORTED' });
});

test('rejects a forged manifest identity before reading text', async () => {
  const { manifest, objects } = await fixture();
  const forged: SnapshotManifest = { ...manifest, snapshotId: `snapshot-${'f'.repeat(64)}` };
  await expect(readSnapshotText(forged, objects, 'src/example.ts', limits))
    .rejects.toMatchObject({ code: 'SNAPSHOT_ID_MISMATCH' });
});

test('rejects unexpected object bytes, forged object length and out-of-range locators', async () => {
  const { manifest, objects } = await fixture('aa\nbb\n');
  await expect(readSnapshotText(manifest, [...objects, { path: 'objects/unexpected.md', bytes: utf8('x') }], 'src/example.ts', limits))
    .rejects.toMatchObject({ code: 'OBJECT_CONFLICT' });
  const sourceFile = required(manifest.files[0], 'manifest file');
  const firstObject = required(manifest.objects[0], 'manifest object');
  const forgedLength = await createSnapshotManifest({
    projectId: manifest.projectId, policyVersion: manifest.policyVersion, publishedAt: manifest.publishedAt,
    repositories: manifest.repositories, files: manifest.files,
    objects: [{ ...firstObject, byteLength: firstObject.byteLength + 1 }, ...manifest.objects.slice(1)],
  });
  await expect(readSnapshotText(forgedLength, objects, 'src/example.ts', limits))
    .rejects.toMatchObject({ code: 'OBJECT_INTEGRITY_MISMATCH' });
  const details = sourceFile.details as Record<string, unknown>;
  const segments = [...(details.segments as Array<Record<string, unknown>> ?? [])];
  const firstSegment = required(segments[0], 'locator');
  const outOfRangeDetails = JSON.parse(JSON.stringify({
    ...details,
    segments: [{ ...firstSegment, bodyByteOffset: firstObject.byteLength + 1 }, ...segments.slice(1)],
  }));
  const outOfRange = await createSnapshotManifest({
    projectId: manifest.projectId, policyVersion: manifest.policyVersion, publishedAt: manifest.publishedAt,
    repositories: manifest.repositories, objects: manifest.objects,
    files: [{ ...sourceFile, details: outOfRangeDetails }],
  });
  await expect(readSnapshotText(outOfRange, objects, 'src/example.ts', limits))
    .rejects.toMatchObject({ code: 'TEXT_DETAILS_INVALID' });
});

test('rejects same-length same-line-count wrong text even when the mutated object hash is self-consistent', async () => {
  const { manifest, objects } = await fixture('aa\nbb\n');
  const sourceFile = required(manifest.files[0], 'manifest file');
  const sourceObject = required(manifest.objects[0], 'manifest object');
  const originalBytes = required(objects[0], 'published object').bytes;
  const originalText = new TextDecoder().decode(originalBytes);
  const mutatedText = originalText.replace('aa\nbb\n', 'cc\ndd\n');
  expect(utf8(mutatedText).byteLength).toBe(originalBytes.byteLength);
  const mutatedBytes = utf8(mutatedText);
  const mutatedSha = createHash('sha256').update(mutatedBytes).digest('hex');
  const details = JSON.parse(JSON.stringify(sourceFile.details)) as Record<string, unknown>;
  const segments = details.segments as Array<Record<string, unknown>>;
  for (const segment of segments) segment.objectSha256 = mutatedSha;
  const selfConsistent = await createSnapshotManifest({
    projectId: manifest.projectId, policyVersion: manifest.policyVersion, publishedAt: manifest.publishedAt,
    repositories: manifest.repositories,
    objects: [{ ...sourceObject, sha256: mutatedSha }, ...manifest.objects.slice(1)],
    files: [{ ...sourceFile, details: JSON.parse(JSON.stringify(details)) }],
  });
  await expect(readSnapshotText(selfConsistent, [{ path: sourceObject.path, bytes: mutatedBytes }], 'src/example.ts', limits))
    .rejects.toMatchObject({ code: 'TEXT_INTEGRITY_MISMATCH' });
});
