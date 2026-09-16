import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  buildSourceTextPackage,
  createTextSnapshotManifest,
  readSnapshotText,
  stageSourceTextFile,
} from '../../src/index.js';
import { inspectSourceSnapshotStoreUsage, pruneSourceSnapshots, publishSourceSnapshot } from '../../src/node.js';

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
const packV2 = {
  targetObjectBytes: 4096,
  maxObjectBytes: 8192,
  maxObjectCount: 50,
  maxObjectBytesTotal: 500_000,
  textFormatVersion: 2 as const,
};
const limits = { maxObjectBytes: 1_048_576, maxFileBytes: 16_777_216, maxTotalBytes: 67_108_864 };
const required = <T>(value: T | undefined, label: string): T => {
  if (value === undefined) throw new Error(`missing ${label}`);
  return value;
};
test('deduplicates exact raw and normalized content only within the same group', async () => {
  const [first, second] = await Promise.all([
    stageSourceTextFile({ path: 'src/a.ts', group: 'code', bytes: utf8('same\n') }),
    stageSourceTextFile({ path: 'src/b.ts', group: 'code', bytes: utf8('same\n') }),
  ]);
  const packed = await buildSourceTextPackage([first, second], packV2);
  expect(packed.objects).toHaveLength(1);
  expect(packed.files.map(file => file.path)).toEqual(['src/a.ts', 'src/b.ts']);
  const a = required(packed.files.find(file => file.path === 'src/a.ts'), 'a');
  const b = required(packed.files.find(file => file.path === 'src/b.ts'), 'b');
  expect(a.segments.map(segment => segment.objectPath)).toEqual(b.segments.map(segment => segment.objectPath));
  expect(a.segments.map(segment => segment.bodyByteOffset)).toEqual(b.segments.map(segment => segment.bodyByteOffset));
  expect(a.segments.map(segment => segment.bodyByteLength)).toEqual(b.segments.map(segment => segment.bodyByteLength));
  expect(packed.objects[0]?.content).not.toContain('src/a.ts');
  expect(packed.objects[0]?.content).not.toContain('src/b.ts');
  expect(packed.metrics).toEqual({
    logicalSourceBytes: first.byteLength + second.byteLength,
    uniqueNormalizedBodyBytes: first.normalizedByteLength,
    objectContainerBytes: packed.objects.reduce((sum, object) => sum + object.byteLength, 0),
  });
  const reversed = await buildSourceTextPackage([second, first], packV2);
  expect(reversed.objects.map(object => [object.path, object.content])).toEqual(packed.objects.map(object => [object.path, object.content]));
});

test('does not deduplicate normalized-equal files when raw bytes differ', async () => {
  const [lf, crlf] = await Promise.all([
    stageSourceTextFile({ path: 'src/lf.ts', group: 'code', bytes: utf8('same\n') }),
    stageSourceTextFile({ path: 'src/crlf.ts', group: 'code', bytes: utf8('same\r\n') }),
  ]);
  expect(lf.normalizedSha256).toBe(crlf.normalizedSha256);
  expect(lf.sha256).not.toBe(crlf.sha256);
  const packed = await buildSourceTextPackage([lf, crlf], packV2);
  expect(packed.objects).toHaveLength(1);
  const lfFile = required(packed.files.find(file => file.path === 'src/lf.ts'), 'lf file');
  const crlfFile = required(packed.files.find(file => file.path === 'src/crlf.ts'), 'crlf file');
  expect(lfFile.segments[0]?.bodyByteOffset).not.toBe(crlfFile.segments[0]?.bodyByteOffset);
});

test('does not deduplicate identical files across different groups', async () => {
  const [code, docs] = await Promise.all([
    stageSourceTextFile({ path: 'src/value.ts', group: 'code', bytes: utf8('same\n') }),
    stageSourceTextFile({ path: 'docs/value.md', group: 'docs', bytes: utf8('same\n') }),
  ]);
  const packed = await buildSourceTextPackage([code, docs], packV2);
  expect(packed.objects).toHaveLength(2);
  expect(new Set(packed.objects.map(object => object.group))).toEqual(new Set(['code', 'docs']));
});

test('deduplicated logical paths remain independently readable from published bytes', async () => {
  const [first, second] = await Promise.all([
    stageSourceTextFile({ path: 'src/a.ts', group: 'code', bytes: utf8('same\n') }),
    stageSourceTextFile({ path: 'src/b.ts', group: 'code', bytes: utf8('same\n') }),
  ]);
  const packed = await buildSourceTextPackage([first, second], packV2);
  const manifest = await createTextSnapshotManifest({
    projectId: 'dedup-fixture', policyVersion: '2', publishedAt: 1,
    repositories: [], textPackage: packed,
  });
  const objects = packed.objects.map(object => ({ path: object.path, bytes: utf8(object.content) }));
  const [a, b] = await Promise.all([
    readSnapshotText(manifest, objects, 'src/a.ts', limits),
    readSnapshotText(manifest, objects, 'src/b.ts', limits),
  ]);
  expect(a.text).toBe('same\n');
  expect(b.text).toBe('same\n');
  expect(a.sourceSha256).toBe(first.sha256);
  expect(b.sourceSha256).toBe(second.sha256);
});


test('alias add/remove keeps v2 content-block object identity stable', async () => {
  const [a, b] = await Promise.all([
    stageSourceTextFile({ path: 'src/a.ts', group: 'code', bytes: utf8('same\n') }),
    stageSourceTextFile({ path: 'src/b.ts', group: 'code', bytes: utf8('same\n') }),
  ]);
  const aliases = await buildSourceTextPackage([a, b], packV2);
  const onlyB = await buildSourceTextPackage([b], packV2);
  expect(aliases.objects.map(object => [object.path, object.content])).toEqual(
    onlyB.objects.map(object => [object.path, object.content]),
  );
});

test('shared v2 object is reused across snapshots, survives old-alias GC, and cannot cross project ownership', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dedup-store-'));
  const source = join(base, 'source'); const targetRoot = join(base, 'target'); const state = join(base, 'state');
  await Promise.all([mkdir(source), mkdir(targetRoot), mkdir(state)]);
  try {
    const a = await stageSourceTextFile({ path: 'src/a.ts', group: 'code', bytes: utf8('same\n') });
    const b = await stageSourceTextFile({ path: 'src/b.ts', group: 'code', bytes: utf8('same\n') });
    const firstPackage = await buildSourceTextPackage([a], packV2);
    const secondPackage = await buildSourceTextPackage([a, b], packV2);
    const firstManifest = await createTextSnapshotManifest({ projectId: 'dedup-project', policyVersion: '2', publishedAt: 1, repositories: [], textPackage: firstPackage });
    const secondManifest = await createTextSnapshotManifest({ projectId: 'dedup-project', policyVersion: '2', publishedAt: 2, repositories: [], textPackage: secondPackage });
    const opts = { sourceRoot: source, targetRoot, lockPath: join(state, 'store.lock'), ownerId: 'dedup-owner' };
    await publishSourceSnapshot({ manifest: firstManifest, textPackage: firstPackage }, opts);
    const second = await publishSourceSnapshot({ manifest: secondManifest, textPackage: secondPackage }, opts);
    expect(second.objectsReused).toBe(1);
    expect(second.bytesWritten).toBeGreaterThan(0);
    expect((await inspectSourceSnapshotStoreUsage({ targetRoot, ownerId: 'dedup-owner', now: 3, keepCount: 2 })).objectFileCount).toBe(1);
    const pruned = await pruneSourceSnapshots({ targetRoot, ownerId: 'dedup-owner', lockPath: opts.lockPath, now: 10, keepCount: 1, orphanGraceMs: 0 });
    expect(pruned.removedSnapshotIds).toContain(firstManifest.snapshotId);
    expect(pruned.removedObjectPaths).toEqual([]);
    const foreignManifest = await createTextSnapshotManifest({ projectId: 'foreign-project', policyVersion: '2', publishedAt: 3, repositories: [], textPackage: secondPackage });
    await expect(publishSourceSnapshot({ manifest: foreignManifest, textPackage: secondPackage }, opts))
      .rejects.toMatchObject({ code: 'TARGET_PROJECT_MISMATCH' });
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('does not deduplicate same-size different raw content within one group', async () => {
  const [left, right] = await Promise.all([
    stageSourceTextFile({ path: 'src/left.ts', group: 'code', bytes: utf8('left\n') }),
    stageSourceTextFile({ path: 'src/rght.ts', group: 'code', bytes: utf8('rght\n') }),
  ]);
  expect(left.byteLength).toBe(right.byteLength);
  expect(left.sha256).not.toBe(right.sha256);
  const packed = await buildSourceTextPackage([left, right], packV2);
  const leftFile = required(packed.files.find(file => file.path === 'src/left.ts'), 'left file');
  const rightFile = required(packed.files.find(file => file.path === 'src/rght.ts'), 'right file');
  expect(leftFile.segments[0]?.bodyByteOffset).not.toBe(rightFile.segments[0]?.bodyByteOffset);
  expect(packed.metrics.uniqueNormalizedBodyBytes).toBe(left.normalizedByteLength + right.normalizedByteLength);
});
