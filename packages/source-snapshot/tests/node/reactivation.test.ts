import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test } from 'vitest';
import { buildSourceTextPackage, createTextSnapshotManifest, stageSourceTextFile } from '../../src/index.js';
import { publishSourceSnapshot, verifyPublishedSourceSnapshot } from '../../src/node.js';

const roots: string[] = [];
const encoder = new TextEncoder();
const first = <T>(values: readonly T[]): T => {
  const value = values[0];
  if (value === undefined) throw new Error('fixture value missing');
  return value;
};
const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'snapshot-reactivation-'));
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});
const makeBundle = async (version: string, publishedAt: number, textFormatVersion: 1 | 2 = 2) => {
  const staged = await stageSourceTextFile({
    path: 'src/value.ts', group: 'core', bytes: encoder.encode(`export const value = '${version}'\n`),
  });
  const textPackage = await buildSourceTextPackage([staged], {
    targetObjectBytes: 4096, maxObjectBytes: 8192, maxObjectCount: 10, maxObjectBytesTotal: 100_000,
    textFormatVersion,
  });
  const manifest = await createTextSnapshotManifest({
    projectId: 'reactivation-fixture', policyVersion: '2', publishedAt,
    repositories: [{ path: '', head: version.repeat(40), branch: 'dev', dirty: false }], textPackage,
  });
  return { manifest, textPackage };
};
const fixture = async () => {
  const base = await makeRoot();
  const sourceRoot = join(base, 'source');
  const targetRoot = join(base, 'target');
  await mkdir(sourceRoot); await mkdir(targetRoot);
  return {
    base, sourceRoot, targetRoot, lockPath: join(base, 'publish.lock'), ownerId: 'reactivation-owner',
  };
};
const publishOptions = (value: Awaited<ReturnType<typeof fixture>>) => ({
  sourceRoot: value.sourceRoot, targetRoot: value.targetRoot, lockPath: value.lockPath, ownerId: value.ownerId,
});
test('reactivates an existing canonical snapshot without rewriting immutable metadata', async () => {
  const store = await fixture();
  const a = await makeBundle('a', 1);
  const b = await makeBundle('b', 2);
  await publishSourceSnapshot(a, publishOptions(store));
  const snapshotRoot = join(store.targetRoot, 'snapshots', a.manifest.snapshotId);
  const names = ['SNAPSHOT.json', 'READ-INDEX.json', 'INDEX.md', 'CHANGES.json'] as const;
  const before = new Map<string, { content: string; mtimeMs: number }>();
  for (const name of names) {
    const path = join(snapshotRoot, name);
    before.set(name, { content: await readFile(path, 'utf8'), mtimeMs: (await stat(path)).mtimeMs });
  }
  await publishSourceSnapshot(b, publishOptions(store));
  const result = await publishSourceSnapshot(a, publishOptions(store));
  expect(result).toMatchObject({ status: 'LOCAL_VERIFIED', activation: 'reused', snapshotId: a.manifest.snapshotId });
  for (const name of names) {
    const path = join(snapshotRoot, name);
    const saved = before.get(name);
    if (saved === undefined) throw new Error(`missing baseline ${name}`);
    expect(await readFile(path, 'utf8')).toBe(saved.content);
    expect((await stat(path)).mtimeMs).toBe(saved.mtimeMs);
  }
  const entry = await readFile(join(store.targetRoot, '00-SOURCE-SNAPSHOT.md'), 'utf8');
  expect(entry).toContain(`snapshot_id: ${a.manifest.snapshotId}`);
  const repeated = await publishSourceSnapshot(a, publishOptions(store));
  expect(repeated.status).toBe('NO_CHANGES');
});
test('refuses to reactivate a corrupted historical snapshot and leaves current unchanged', async () => {
  const store = await fixture();
  const a = await makeBundle('a', 1);
  const b = await makeBundle('b', 2);
  await publishSourceSnapshot(a, publishOptions(store));
  await publishSourceSnapshot(b, publishOptions(store));
  const aObject = first(a.textPackage.objects);
  await writeFile(join(store.targetRoot, ...aObject.path.split('/')), 'corrupted', 'utf8');
  await expect(publishSourceSnapshot(a, publishOptions(store)))
    .rejects.toMatchObject({ code: 'OBJECT_INTEGRITY_MISMATCH' });
  const entry = await readFile(join(store.targetRoot, '00-SOURCE-SNAPSHOT.md'), 'utf8');
  expect(entry).toContain(`snapshot_id: ${b.manifest.snapshotId}`);
});

test('reports explicit object and text verification levels', async () => {
  const store = await fixture();
  const value = await makeBundle('c', 3);
  await publishSourceSnapshot(value, publishOptions(store));
  const objects = await verifyPublishedSourceSnapshot({ targetRoot: store.targetRoot, ownerId: store.ownerId });
  expect(objects).toMatchObject({
    requestedLevel: 'objects', verifiedLevel: 'objects', verifiedFileCount: 0, verifiedPaths: [],
  });
  const text = await verifyPublishedSourceSnapshot({
    targetRoot: store.targetRoot, ownerId: store.ownerId, level: 'text',
  });
  expect(text).toMatchObject({
    requestedLevel: 'text', verifiedLevel: 'text', verifiedFileCount: 1, verifiedPaths: ['src/value.ts'],
  });
});
test('text verification fails closed for legacy source text details', async () => {
  const store = await fixture();
  const legacy = await makeBundle('d', 4, 1);
  await publishSourceSnapshot(legacy, publishOptions(store));
  const objects = await verifyPublishedSourceSnapshot({
    targetRoot: store.targetRoot, ownerId: store.ownerId, level: 'objects',
  });
  expect(objects.verifiedLevel).toBe('objects');
  await expect(verifyPublishedSourceSnapshot({
    targetRoot: store.targetRoot, ownerId: store.ownerId, level: 'text',
  })).rejects.toMatchObject({ code: 'TEXT_FORMAT_UNSUPPORTED' });
});
test('rejects an unknown stored manifest schema version before verification', async () => {
  const store = await fixture();
  const value = await makeBundle('e', 5);
  await publishSourceSnapshot(value, publishOptions(store));
  const path = join(store.targetRoot, 'snapshots', value.manifest.snapshotId, 'SNAPSHOT.json');
  const stored = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  stored.schemaVersion = 99;
  await writeFile(path, JSON.stringify(stored, null, 2) + '\n', 'utf8');
  await expect(verifyPublishedSourceSnapshot({ targetRoot: store.targetRoot, ownerId: store.ownerId }))
    .rejects.toMatchObject({ code: 'SNAPSHOT_ID_MISMATCH' });
});
