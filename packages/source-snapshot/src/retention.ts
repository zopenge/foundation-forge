import type { SnapshotRetentionInput, SnapshotRetentionPlan } from './contracts.js';
import { SourceSnapshotError } from './errors.js';
import { assertArray, assertCount, compareStrings, objectPath, uniquePaths } from './validation.js';

export const planSnapshotRetention = (input: SnapshotRetentionInput): SnapshotRetentionPlan => {
  const keepCount = input.keepCount ?? 3;
  const grace = input.orphanGraceMs ?? 7 * 86_400_000;
  assertCount(input.now, 'now'); assertCount(keepCount, 'keepCount'); assertCount(grace, 'orphanGraceMs');
  if (keepCount === 0) throw new SourceSnapshotError('INVALID_INPUT', { field: 'keepCount' });
  assertArray(input.snapshots, 'snapshots'); uniquePaths(input.objectPaths);
  input.objectPaths.forEach(objectPath);
  const current = input.snapshots.find(value => value.snapshotId === input.currentSnapshotId);
  if (current === undefined) throw new SourceSnapshotError('CURRENT_SNAPSHOT_MISSING');
  const seen = new Set<string>(); const allObjects = new Map<string, string>();
  for (const snapshot of input.snapshots) {
    if (snapshot.schemaVersion !== 1 || !/^snapshot-[a-f0-9]{64}$/u.test(snapshot.snapshotId)) throw new SourceSnapshotError('INVALID_INPUT', { field: 'snapshotId' });
    if (seen.has(snapshot.snapshotId)) throw new SourceSnapshotError('DUPLICATE_SNAPSHOT');
    seen.add(snapshot.snapshotId);
    if (snapshot.projectId !== current.projectId) throw new SourceSnapshotError('PROJECT_MISMATCH');
    assertCount(snapshot.publishedAt, 'publishedAt');
    for (const object of snapshot.objects) {
      objectPath(object.path);
      const value = `${object.sha256}:${object.byteLength}`;
      if (allObjects.has(object.path) && allObjects.get(object.path) !== value) throw new SourceSnapshotError('OBJECT_CONFLICT', { path: object.path });
      allObjects.set(object.path, value);
    }
  }
  const ordered = [...input.snapshots].sort((a, b) => b.publishedAt - a.publishedAt || compareStrings(a.snapshotId, b.snapshotId));
  const retained = [current, ...ordered.filter(value => value.snapshotId !== current.snapshotId).slice(0, keepCount - 1)];
  const ids = new Set(retained.map(value => value.snapshotId));
  const references = new Set(retained.flatMap(value => value.objects.map(object => object.path)));
  const objectSet = new Set(input.objectPaths);
  for (const value of references) if (!objectSet.has(value)) throw new SourceSnapshotError('DANGLING_OBJECT', { path: value });
  const previous = input.orphanedSince ?? {};
  if (typeof previous !== 'object' || previous === null || Array.isArray(previous)) throw new SourceSnapshotError('INVALID_INPUT', { field: 'orphanedSince' });
  for (const [name, since] of Object.entries(previous)) { objectPath(name); assertCount(since, 'orphanedSince'); }
  const orphans = [...objectSet].filter(value => !references.has(value)).sort(compareStrings);
  const next = Object.fromEntries(orphans.map(value => [value, previous[value] ?? input.now]));
  return Object.freeze({
    currentSnapshotId: current.snapshotId,
    retainedSnapshotIds: Object.freeze(retained.map(value => value.snapshotId)),
    removeSnapshotIds: Object.freeze(ordered.filter(value => !ids.has(value.snapshotId)).map(value => value.snapshotId)),
    referencedObjectPaths: Object.freeze([...references].sort(compareStrings)),
    orphanObjectPaths: Object.freeze(orphans),
    removeObjectPaths: Object.freeze(orphans.filter(value => input.now - (next[value] ?? input.now) >= grace)),
    nextOrphanedSince: Object.freeze(next),
  });
};
