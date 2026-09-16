import { expect, test } from 'vitest';
import { createSnapshotManifest, planSnapshotRetention } from '../../src/index.js';

const makeSnapshot = (policyVersion: string, publishedAt: number) => createSnapshotManifest({
  projectId: 'pin-fixture',
  policyVersion,
  publishedAt,
  repositories: [],
  files: [],
  objects: [],
});

test('keepCount=1 retains current plus an explicitly pinned older snapshot', async () => {
  const [old, middle, current] = await Promise.all([
    makeSnapshot('old', 1), makeSnapshot('middle', 2), makeSnapshot('current', 3),
  ]);
  const plan = planSnapshotRetention({
    snapshots: [old, middle, current],
    currentSnapshotId: current.snapshotId,
    objectPaths: [],
    now: 100,
    keepCount: 1,
    pins: [{ pinId: 'report-a', snapshotId: old.snapshotId, reasonCode: 'report', createdAt: 10 }],
  });
  expect(plan.retainedSnapshotIds).toContain(current.snapshotId);
  expect(plan.retainedSnapshotIds).toContain(old.snapshotId);
  expect(plan.retainedSnapshotIds).not.toContain(middle.snapshotId);
  expect(plan.removeSnapshotIds).toEqual([middle.snapshotId]);
});

test('expired pins do not protect a snapshot', async () => {
  const old = await makeSnapshot('old', 1);
  const current = await makeSnapshot('current', 2);
  const plan = planSnapshotRetention({
    snapshots: [old, current], currentSnapshotId: current.snapshotId,
    objectPaths: [], now: 100, keepCount: 1,
    pins: [{ pinId: 'expired', snapshotId: old.snapshotId, reasonCode: 'report', createdAt: 1, expiresAt: 100 }],
  });
  expect(plan.retainedSnapshotIds).toEqual([current.snapshotId]);
  expect(plan.removeSnapshotIds).toEqual([old.snapshotId]);
});

test('pin validation rejects duplicate ids, unknown targets and invalid times', async () => {
  const old = await makeSnapshot('old', 1);
  const current = await makeSnapshot('current', 2);
  const base = { snapshots: [old, current], currentSnapshotId: current.snapshotId, objectPaths: [], now: 100 };
  expect(() => planSnapshotRetention({ ...base, pins: [
    { pinId: 'same', snapshotId: old.snapshotId, reasonCode: 'a', createdAt: 1 },
    { pinId: 'same', snapshotId: current.snapshotId, reasonCode: 'b', createdAt: 2 },
  ] })).toThrowError(expect.objectContaining({ code: 'PIN_STATE_INVALID' }));
  expect(() => planSnapshotRetention({ ...base, pins: [
    { pinId: 'missing', snapshotId: `snapshot-${'f'.repeat(64)}`, reasonCode: 'a', createdAt: 1 },
  ] })).toThrowError(expect.objectContaining({ code: 'PIN_TARGET_MISSING' }));
  expect(() => planSnapshotRetention({ ...base, pins: [
    { pinId: 'bad-time', snapshotId: old.snapshotId, reasonCode: 'a', createdAt: -1 },
  ] })).toThrowError(expect.objectContaining({ code: 'PIN_STATE_INVALID' }));
});
