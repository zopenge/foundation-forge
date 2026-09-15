import { expect, test } from 'vitest';
import { createSnapshotManifest, compareSnapshotFiles, planSnapshotRetention } from '../src/index.js';

const at = <T>(values: readonly T[], index: number): T => {
  const value = values[index];
  if (value === undefined) throw new Error('Fixture index is missing');
  return value;
};

const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);
const day = 86_400_000;
const start = Date.parse('2026-09-01T00:00:00.000Z');
const input = (version = 'a', publishedAt = start) => ({
  projectId: 'fixture-project', policyVersion: '1', publishedAt,
  repositories: [{ path: '', head: version.repeat(40), branch: 'dev', dirty: false }],
  files: [{ path: 'src/a.ts', sha256: version === 'a' ? hashA : hashB, byteLength: 10, objectPaths: [`objects/${version}.md`] }],
  objects: [{ path: `objects/${version}.md`, sha256: version === 'a' ? hashA : hashB, byteLength: 30 }],
});

test('identity ignores publication time but binds project, policy and repository state', async () => {
  const a = await createSnapshotManifest(input());
  expect((await createSnapshotManifest(input('a', start + day))).snapshotId).toBe(a.snapshotId);
  for (const change of [{ projectId: 'second-project' }, { policyVersion: '2' }, { repositories: [{ path: '', head: 'c'.repeat(40), branch: 'dev', dirty: false }] }]) {
    expect((await createSnapshotManifest({ ...input(), ...change })).snapshotId).not.toBe(a.snapshotId);
  }
  expect(a.snapshotId).toMatch(/^snapshot-[a-f0-9]{64}$/u);
  expect(Object.isFrozen(a)).toBe(true);
  expect(Object.isFrozen(a.files[0]?.objectPaths)).toBe(true);
});

test('normalizes ordering without mutating caller arrays', async () => {
  const base = input();
  const files = [at(base.files, 0), { ...at(base.files, 0), path: 'a.ts' }];
  const first = await createSnapshotManifest({ ...base, files });
  const second = await createSnapshotManifest({ ...base, files: [...files].reverse() });
  expect(first.snapshotId).toBe(second.snapshotId);
  expect(files.map(file => file.path)).toEqual(['src/a.ts', 'a.ts']);
  expect(first.files.map(file => file.path)).toEqual(['a.ts', 'src/a.ts']);
});

test('rejects invalid paths, collisions, digests, counts and dangling object references', async () => {
  const base = input();
  for (const file of [
    { ...at(base.files, 0), path: '../escape' },
    { ...at(base.files, 0), sha256: 'invalid' },
    { ...at(base.files, 0), byteLength: -1 },
    { ...at(base.files, 0), objectPaths: ['objects/missing.md'] },
  ]) await expect(createSnapshotManifest({ ...base, files: [file] })).rejects.toBeDefined();
  await expect(createSnapshotManifest({ ...base, files: [at(base.files, 0), at(base.files, 0)] })).rejects.toMatchObject({ code: 'DUPLICATE_PATH' });
  await expect(createSnapshotManifest({ ...base, files: [at(base.files, 0), { ...at(base.files, 0), path: 'SRC/A.ts' }] })).rejects.toMatchObject({ code: 'CASE_COLLISION' });
  await expect(createSnapshotManifest({ ...base, projectId: '../private' })).rejects.toMatchObject({ code: 'INVALID_PROJECT_ID' });
});

test('reports additions, modifications, removals and rename as two paths', async () => {
  const previous = await createSnapshotManifest(input());
  const modified = await createSnapshotManifest(input('b'));
  expect(compareSnapshotFiles(previous, modified)).toEqual({ added: [], changed: ['src/a.ts'], removed: [] });
  const renamed = await createSnapshotManifest({ ...input(), files: [{ ...at(input().files, 0), path: 'src/new.ts' }] });
  expect(compareSnapshotFiles(previous, renamed)).toEqual({ added: ['src/new.ts'], changed: [], removed: ['src/a.ts'] });
  expect(compareSnapshotFiles(null, previous)).toEqual({ added: ['src/a.ts'], changed: [], removed: [] });
  expect(compareSnapshotFiles(previous, previous)).toEqual({ added: [], changed: [], removed: [] });
  const other = await createSnapshotManifest({ ...input(), projectId: 'other' });
  expect(() => compareSnapshotFiles(previous, other)).toThrowError(expect.objectContaining({ code: 'PROJECT_MISMATCH' }));
});

test('retains current even when older and preserves every shared referenced object', async () => {
  const snapshots = await Promise.all(['a', 'b', 'c', 'd'].map((version, index) => createSnapshotManifest(input(version, start + index * day))));
  const result = planSnapshotRetention({ snapshots, currentSnapshotId: at(snapshots, 0).snapshotId, objectPaths: ['objects/a.md','objects/b.md','objects/c.md','objects/d.md'], now: start + 4 * day });
  expect(result.retainedSnapshotIds).toHaveLength(3);
  expect(result.retainedSnapshotIds).toContain(at(snapshots, 0).snapshotId);
  expect(result.removeSnapshotIds).toEqual([at(snapshots, 1).snapshotId]);
  expect(result.referencedObjectPaths).toEqual(['objects/a.md','objects/c.md','objects/d.md']);
  expect(result.removeObjectPaths).toEqual([]);
  expect(result.nextOrphanedSince).toEqual({ 'objects/b.md': start + 4 * day });
});

test('starts grace at observation, never at file age, and expires at seven days', async () => {
  const current = await createSnapshotManifest(input());
  const base = { snapshots: [current], currentSnapshotId: current.snapshotId, objectPaths: ['objects/a.md','objects/old.md'] };
  const initial = planSnapshotRetention({ ...base, now: start });
  expect(initial.removeObjectPaths).toEqual([]);
  const before = planSnapshotRetention({ ...base, orphanedSince: initial.nextOrphanedSince, now: start + 7 * day - 1 });
  expect(before.removeObjectPaths).toEqual([]);
  const after = planSnapshotRetention({ ...base, orphanedSince: initial.nextOrphanedSince, now: start + 7 * day });
  expect(after.removeObjectPaths).toEqual(['objects/old.md']);
});

test('resets orphan tracking when referenced again', async () => {
  const current = await createSnapshotManifest(input());
  const result = planSnapshotRetention({ snapshots: [current], currentSnapshotId: current.snapshotId, objectPaths: ['objects/a.md'], orphanedSince: { 'objects/a.md': start }, now: start + 20 * day });
  expect(result.nextOrphanedSince).toEqual({});
  expect(result.removeObjectPaths).toEqual([]);
});

test('fails closed on missing current, malformed state, missing references and mixed projects', async () => {
  const current = await createSnapshotManifest(input());
  const base = { snapshots: [current], currentSnapshotId: current.snapshotId, objectPaths: ['objects/a.md'], now: start };
  for (const invalid of [ { currentSnapshotId: 'unknown' }, { keepCount: 0 }, { orphanGraceMs: -1 }, { objectPaths: [] }, { orphanedSince: { 'objects/old.md': Number.NaN } }, { now: Number.NaN } ]) {
    expect(() => planSnapshotRetention({ ...base, ...invalid })).toThrow();
  }
  const other = await createSnapshotManifest({ ...input(), projectId: 'other' });
  expect(() => planSnapshotRetention({ ...base, snapshots: [current, other] })).toThrowError(expect.objectContaining({ code: 'PROJECT_MISMATCH' }));
  expect(() => planSnapshotRetention({ ...base, snapshots: [current, current] })).toThrowError(expect.objectContaining({ code: 'DUPLICATE_SNAPSHOT' }));
});


test('freezes identity metadata before asynchronous hashing', async () => {
  const value = input();
  const pending = createSnapshotManifest(value);
  value.projectId = 'mutated-project';
  value.policyVersion = 'mutated-policy';
  value.publishedAt = start + day;
  const result = await pending;
  expect(result.projectId).toBe('fixture-project');
  expect(result.policyVersion).toBe('1');
  expect(result.publishedAt).toBe(start);
  expect(result.snapshotId).toBe((await createSnapshotManifest(input())).snapshotId);
});


test('snapshot identity binds JSON file details used by publication verification', async () => {
  const base = input();
  const first = await createSnapshotManifest({
    ...base,
    files: [{ ...at(base.files, 0), details: { group: 'core', lineCount: 1 } }],
  });
  const second = await createSnapshotManifest({
    ...base,
    files: [{ ...at(base.files, 0), details: { group: 'core', lineCount: 2 } }],
  });
  expect(first.snapshotId).not.toBe(second.snapshotId);
  expect(first.files[0]?.details).toEqual({ group: 'core', lineCount: 1 });
  expect(Object.isFrozen(first.files[0]?.details)).toBe(true);
});
