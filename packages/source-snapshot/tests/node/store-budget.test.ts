import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test } from 'vitest';
import { buildSourceTextPackage, createTextSnapshotManifest, stageSourceTextFile } from '../../src/index.js';
import { inspectSourceSnapshotPins, inspectSourceSnapshotStoreUsage, pruneSourceSnapshots, publishSourceSnapshot, upsertSourceSnapshotPin } from '../../src/node.js';

const roots: string[] = [];
const makeRoot = async () => {
  const base = await mkdtemp(join(tmpdir(), 'snapshot-budget-')); roots.push(base);
  const source = join(base, 'source'); const targetRoot = join(base, 'target'); const state = join(base, 'state');
  await Promise.all([mkdir(source), mkdir(targetRoot), mkdir(state)]);
  return { base, source, targetRoot, lockPath: join(state, 'snapshot.lock'), ownerId: 'budget-owner' };
};
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))); });
const bundle = async (identity: string, content: string, publishedAt: number) => {
  const staged = await stageSourceTextFile({ path: 'src/value.ts', group: 'core', bytes: new TextEncoder().encode(content) });
  const textPackage = await buildSourceTextPackage([staged], { targetObjectBytes: 4096, maxObjectBytes: 8192, maxObjectCount: 10, maxObjectBytesTotal: 100_000, textFormatVersion: 2 });
  const manifest = await createTextSnapshotManifest({ projectId: 'budget-project', policyVersion: identity, publishedAt, repositories: [], textPackage });
  return { manifest, textPackage };
};
const options = (store: Awaited<ReturnType<typeof makeRoot>>) => ({ sourceRoot: store.source, targetRoot: store.targetRoot, lockPath: store.lockPath, ownerId: store.ownerId });

test('managed physical usage counts a shared object once and ignores manual directories', async () => {
  const store = await makeRoot(); const a = await bundle('a', 'same\n', 1); const b = await bundle('b', 'same\n', 2);
  await publishSourceSnapshot(a, options(store)); await publishSourceSnapshot(b, options(store));
  const before = await inspectSourceSnapshotStoreUsage({ targetRoot: store.targetRoot, ownerId: store.ownerId, now: 10, keepCount: 2 });
  expect(before.objectFileCount).toBe(1);
  expect(before.objectBytes).toBe(a.textPackage.objects[0]?.byteLength);
  expect(before.snapshotMetadataAndIndexBytes).toBeGreaterThan(0);
  expect(before.stateControlBytes).toBeGreaterThan(0);
  expect(before.retainedUniqueObjectBytes).toBe(before.objectBytes);
  await mkdir(join(store.targetRoot, 'human-notes')); await writeFile(join(store.targetRoot, 'human-notes', 'large.md'), 'x'.repeat(100_000), 'utf8');
  const after = await inspectSourceSnapshotStoreUsage({ targetRoot: store.targetRoot, ownerId: store.ownerId, now: 10, keepCount: 2 });
  expect(after.managedFileCount).toBe(before.managedFileCount); expect(after.managedBytes).toBe(before.managedBytes);
});

test('store usage reports bytes protected only by an explicit pin', async () => {
  const store = await makeRoot(); const old = await bundle('old', 'old\n', 1); const current = await bundle('current', 'current\n', 2);
  await publishSourceSnapshot(old, options(store)); await publishSourceSnapshot(current, options(store));
  const initial = await inspectSourceSnapshotPins({ targetRoot: store.targetRoot, ownerId: store.ownerId });
  await upsertSourceSnapshotPin({ targetRoot: store.targetRoot, ownerId: store.ownerId, lockPath: store.lockPath, expectedRevision: initial.revision,
    pin: { pinId: 'old-report', snapshotId: old.manifest.snapshotId, reasonCode: 'report', createdAt: 1 } });
  const usage = await inspectSourceSnapshotStoreUsage({ targetRoot: store.targetRoot, ownerId: store.ownerId, now: 10, keepCount: 1 });
  expect(usage.pinnedAdditionalProtectionBytes).toBe(old.textPackage.objects[0]?.byteLength);
  expect(usage.retainedUniqueObjectBytes).toBe((old.textPackage.objects[0]?.byteLength ?? 0) + (current.textPackage.objects[0]?.byteLength ?? 0));
});

test('publication fails before switching current when projected managed store exceeds budget', async () => {
  const store = await makeRoot(); const a = await bundle('a', 'a\n', 1); const b = await bundle('b', 'b\n', 2);
  await publishSourceSnapshot(a, options(store));
  const usage = await inspectSourceSnapshotStoreUsage({ targetRoot: store.targetRoot, ownerId: store.ownerId, now: 10 });
  const entryPath = join(store.targetRoot, '00-SOURCE-SNAPSHOT.md'); const before = await readFile(entryPath, 'utf8');
  await expect(publishSourceSnapshot(b, { ...options(store), storeBudget: { maxManagedFiles: usage.managedFileCount, maxManagedBytes: usage.managedBytes } }))
    .rejects.toMatchObject({
      code: 'STORE_BUDGET_EXCEEDED',
      details: {
        currentManagedFileCount: usage.managedFileCount,
        currentManagedBytes: usage.managedBytes,
        projectedManagedFileCount: expect.any(Number),
        projectedManagedBytes: expect.any(Number),
      },
    });
  expect(await readFile(entryPath, 'utf8')).toBe(before);
});

test('store usage separates orphan observation bytes from reclaimable bytes', async () => {
  const store = await makeRoot(); const old = await bundle('old', 'old\n', 1); const current = await bundle('current', 'current\n', 2);
  await publishSourceSnapshot(old, options(store)); await publishSourceSnapshot(current, options(store));
  const oldBytes = old.textPackage.objects[0]?.byteLength ?? 0;
  const observing = await inspectSourceSnapshotStoreUsage({
    targetRoot: store.targetRoot, ownerId: store.ownerId, now: 3, keepCount: 1, orphanGraceMs: 10,
  });
  expect(observing.orphanObservationBytes).toBe(oldBytes);
  expect(observing.reclaimableBytes).toBe(0);
  await pruneSourceSnapshots({
    targetRoot: store.targetRoot, ownerId: store.ownerId, lockPath: store.lockPath,
    now: 3, keepCount: 1, orphanGraceMs: 10,
  });
  const reclaimable = await inspectSourceSnapshotStoreUsage({
    targetRoot: store.targetRoot, ownerId: store.ownerId, now: 13, keepCount: 1, orphanGraceMs: 10,
  });
  expect(reclaimable.orphanObservationBytes).toBe(0);
  expect(reclaimable.reclaimableBytes).toBe(oldBytes);
});
