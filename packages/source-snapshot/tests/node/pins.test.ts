import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test } from 'vitest';
import { buildSourceTextPackage, createTextSnapshotManifest, stageSourceTextFile } from '../../src/index.js';
import {
  inspectSourceSnapshotPins,
  inspectSourceSnapshotRetention,
  publishSourceSnapshot,
  pruneSourceSnapshots,
  removeSourceSnapshotPin,
  upsertSourceSnapshotPin,
} from '../../src/node.js';
import { acquireSourceSnapshotLock } from '../../src/node/lock.js';

const roots: string[] = [];
const makeRoot = async () => {
  const base = await mkdtemp(join(tmpdir(), 'snapshot-pins-')); roots.push(base);
  const source = join(base, 'source'); const targetRoot = join(base, 'target'); const state = join(base, 'state');
  await Promise.all([mkdir(source), mkdir(targetRoot), mkdir(state)]);
  return { base, source, targetRoot, lockPath: join(state, 'snapshot.lock'), ownerId: 'pin-owner' };
};
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))); });
const makeBundle = async (version: string, publishedAt: number) => {
  const staged = await stageSourceTextFile({ path: 'src/value.ts', group: 'core', bytes: new TextEncoder().encode(version + '\n') });
  const textPackage = await buildSourceTextPackage([staged], { targetObjectBytes: 4096, maxObjectBytes: 8192, maxObjectCount: 10, maxObjectBytesTotal: 100_000, textFormatVersion: 2 });
  const manifest = await createTextSnapshotManifest({ projectId: 'pin-project', policyVersion: version, publishedAt, repositories: [], textPackage });
  return { manifest, textPackage };
};
const publish = (store: Awaited<ReturnType<typeof makeRoot>>, bundle: Awaited<ReturnType<typeof makeBundle>>) => publishSourceSnapshot(bundle, {
  sourceRoot: store.source, targetRoot: store.targetRoot, lockPath: store.lockPath, ownerId: store.ownerId,
});

test('pin registry protects an old snapshot without replacing the keepCount base set', async () => {
  const store = await makeRoot(); const old = await makeBundle('old', 1); const current = await makeBundle('current', 2);
  await publish(store, old); await publish(store, current);
  const initial = await inspectSourceSnapshotPins({ targetRoot: store.targetRoot, ownerId: store.ownerId });
  expect(initial.pins).toEqual([]);
  const saved = await upsertSourceSnapshotPin({
    targetRoot: store.targetRoot, ownerId: store.ownerId, lockPath: store.lockPath, expectedRevision: initial.revision,
    pin: { pinId: 'keep-old', snapshotId: old.manifest.snapshotId, reasonCode: 'report', createdAt: 10 },
  });
  expect(saved.pins).toHaveLength(1);
  const retention = await inspectSourceSnapshotRetention({ targetRoot: store.targetRoot, ownerId: store.ownerId, now: 20, keepCount: 1 });
  expect(retention.retainedSnapshotIds).toContain(current.manifest.snapshotId);
  expect(retention.retainedSnapshotIds).toContain(old.manifest.snapshotId);
});

test('pin registry rejects stale revisions, unknown targets and corrupted state', async () => {
  const store = await makeRoot(); const value = await makeBundle('a', 1); await publish(store, value);
  const initial = await inspectSourceSnapshotPins({ targetRoot: store.targetRoot, ownerId: store.ownerId });
  const next = await upsertSourceSnapshotPin({
    targetRoot: store.targetRoot, ownerId: store.ownerId, lockPath: store.lockPath, expectedRevision: initial.revision,
    pin: { pinId: 'a', snapshotId: value.manifest.snapshotId, reasonCode: 'report', createdAt: 1 },
  });
  await expect(removeSourceSnapshotPin({ targetRoot: store.targetRoot, ownerId: store.ownerId, lockPath: store.lockPath, pinId: 'a', expectedRevision: initial.revision }))
    .rejects.toMatchObject({ code: 'PIN_STATE_CONFLICT' });
  await expect(upsertSourceSnapshotPin({
    targetRoot: store.targetRoot, ownerId: store.ownerId, lockPath: store.lockPath, expectedRevision: next.revision,
    pin: { pinId: 'missing', snapshotId: `snapshot-${'f'.repeat(64)}`, reasonCode: 'report', createdAt: 2 },
  })).rejects.toMatchObject({ code: 'PIN_TARGET_MISSING' });
  await writeFile(join(store.targetRoot, '.source-snapshot-pins.json'), '{broken', 'utf8');
  await expect(inspectSourceSnapshotPins({ targetRoot: store.targetRoot, ownerId: store.ownerId })).rejects.toMatchObject({ code: 'PIN_STATE_INVALID' });
});

test('retention dry-run does not mutate pin registry', async () => {
  const store = await makeRoot(); const old = await makeBundle('old', 1); const current = await makeBundle('current', 2);
  await publish(store, old); await publish(store, current);
  const initial = await inspectSourceSnapshotPins({ targetRoot: store.targetRoot, ownerId: store.ownerId });
  await upsertSourceSnapshotPin({ targetRoot: store.targetRoot, ownerId: store.ownerId, lockPath: store.lockPath, expectedRevision: initial.revision,
    pin: { pinId: 'keep-old', snapshotId: old.manifest.snapshotId, reasonCode: 'report', createdAt: 1 } });
  const file = join(store.targetRoot, '.source-snapshot-pins.json'); const before = { text: await readFile(file, 'utf8'), mtime: (await stat(file)).mtimeMs };
  const preview = await pruneSourceSnapshots({ targetRoot: store.targetRoot, ownerId: store.ownerId, lockPath: store.lockPath, now: 10, keepCount: 1, dryRun: true });
  expect(preview.removeSnapshotIds).not.toContain(old.manifest.snapshotId);
  expect(await readFile(file, 'utf8')).toBe(before.text); expect((await stat(file)).mtimeMs).toBe(before.mtime);
});

test('pin, unpin, export and prune contend on the same store lock', async () => {
  const store = await makeRoot(); const current = await makeBundle('current', 1); const next = await makeBundle('next', 2);
  await publish(store, current);
  const initial = await inspectSourceSnapshotPins({ targetRoot: store.targetRoot, ownerId: store.ownerId });
  const pinned = await upsertSourceSnapshotPin({ targetRoot: store.targetRoot, ownerId: store.ownerId, lockPath: store.lockPath,
    expectedRevision: initial.revision, pin: { pinId: 'current', snapshotId: current.manifest.snapshotId, reasonCode: 'lock-test', createdAt: 1 } });
  const release = await acquireSourceSnapshotLock(store.lockPath);
  try {
    await expect(upsertSourceSnapshotPin({ targetRoot: store.targetRoot, ownerId: store.ownerId, lockPath: store.lockPath,
      expectedRevision: pinned.revision, pin: { pinId: 'current', snapshotId: current.manifest.snapshotId, reasonCode: 'lock-test', createdAt: 1 } }))
      .rejects.toMatchObject({ code: 'SNAPSHOT_LOCKED' });
    await expect(removeSourceSnapshotPin({ targetRoot: store.targetRoot, ownerId: store.ownerId, lockPath: store.lockPath,
      expectedRevision: pinned.revision, pinId: 'current' })).rejects.toMatchObject({ code: 'SNAPSHOT_LOCKED' });
    await expect(publish(store, next)).rejects.toMatchObject({ code: 'SNAPSHOT_LOCKED' });
    await expect(pruneSourceSnapshots({ targetRoot: store.targetRoot, ownerId: store.ownerId, lockPath: store.lockPath,
      now: 3, keepCount: 1 })).rejects.toMatchObject({ code: 'SNAPSHOT_LOCKED' });
  } finally { await release(); }
});
