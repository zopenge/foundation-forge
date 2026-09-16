import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createSnapshotManifest, stageSourceTextFile } from '../src/index.js';
import { verifyPublishedSourceSnapshot } from '../src/node.js';
import { createSourceTextSpoolBuilder } from '../src/node/text-spool.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const makeRoot = async (prefix: string): Promise<string> => { const root = await mkdtemp(join(tmpdir(), prefix)); roots.push(root); return root; };

test('verifies thousands of aliases without per-file manifest scans or repeated object reads', async () => {
  const spoolRoot = await makeRoot('snapshot-verify-spool-');
  const targetRoot = await makeRoot('snapshot-verify-target-');
  const builder = await createSourceTextSpoolBuilder({
    spoolRoot,
    pack: { targetObjectBytes: 4096, maxObjectBytes: 8192, maxObjectCount: 100, maxObjectBytesTotal: 1_000_000, textFormatVersion: 2 },
  });
  const base = await stageSourceTextFile({ path: 'src/base.ts', group: 'code', bytes: new TextEncoder().encode('same\n') });
  for (let index = 0; index < 2_000; index += 1) {
    await builder.add(Object.freeze({ ...base, path: `src/alias-${String(index).padStart(5, '0')}.ts` }));
  }
  const prepared = await builder.finish();
  const manifest = await createSnapshotManifest({
    projectId: 'verify-scale', policyVersion: '1', publishedAt: 1, repositories: [],
    files: prepared.files,
    objects: prepared.objects.map(({ path, sha256, byteLength }) => ({ path, sha256, byteLength })),
  });
  await writeFile(join(targetRoot, '.source-snapshot-owner.json'), `${JSON.stringify({ schemaVersion: 1, ownerId: 'verify-owner', projectId: 'verify-scale' })}\n`, 'utf8');
  await writeFile(join(targetRoot, '00-SOURCE-SNAPSHOT.md'), `snapshot_id: ${manifest.snapshotId}\n`, 'utf8');
  for (const object of prepared.objects) {
    const target = join(targetRoot, ...object.path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await import('node:fs/promises').then(fs => fs.copyFile(object.spoolPath, target));
  }
  const snapshotRoot = join(targetRoot, 'snapshots', manifest.snapshotId);
  await mkdir(snapshotRoot, { recursive: true });
  await writeFile(join(snapshotRoot, 'SNAPSHOT.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const verified = await verifyPublishedSourceSnapshot({ targetRoot, ownerId: 'verify-owner', level: 'text' });
  expect(verified.verifiedLevel).toBe('text');
  expect(verified.verifiedFileCount).toBe(2_000);
  await builder.dispose();
}, 5_000);

test('verifies one large file spanning multiple prepared objects', async () => {
  const spoolRoot = await makeRoot('snapshot-verify-multi-spool-');
  const targetRoot = await makeRoot('snapshot-verify-multi-target-');
  const builder = await createSourceTextSpoolBuilder({
    spoolRoot,
    pack: { targetObjectBytes: 2048, maxObjectBytes: 4096, maxObjectCount: 500, maxObjectBytesTotal: 2_000_000, textFormatVersion: 2 },
  });
  const text = Array.from({ length: 4_000 }, (_, index) => `export const value${index} = ${index};\n`).join('');
  const staged = await stageSourceTextFile({ path: 'src/large.ts', group: 'code', bytes: new TextEncoder().encode(text) });
  await builder.add(staged);
  const prepared = await builder.finish();
  expect(prepared.objects.length).toBeGreaterThan(1);
  const manifest = await createSnapshotManifest({
    projectId: 'verify-multi', policyVersion: '1', publishedAt: 1, repositories: [], files: prepared.files,
    objects: prepared.objects.map(({ path, sha256, byteLength }) => ({ path, sha256, byteLength })),
  });
  await writeFile(join(targetRoot, '.source-snapshot-owner.json'), `${JSON.stringify({ schemaVersion: 1, ownerId: 'verify-owner', projectId: 'verify-multi' })}\n`, 'utf8');
  await writeFile(join(targetRoot, '00-SOURCE-SNAPSHOT.md'), `snapshot_id: ${manifest.snapshotId}\n`, 'utf8');
  for (const object of prepared.objects) {
    const target = join(targetRoot, ...object.path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await import('node:fs/promises').then(fs => fs.copyFile(object.spoolPath, target));
  }
  const snapshotRoot = join(targetRoot, 'snapshots', manifest.snapshotId);
  await mkdir(snapshotRoot, { recursive: true });
  await writeFile(join(snapshotRoot, 'SNAPSHOT.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const verified = await verifyPublishedSourceSnapshot({ targetRoot, ownerId: 'verify-owner', level: 'text' });
  expect(verified).toMatchObject({ verifiedLevel: 'text', verifiedFileCount: 1 });
  expect(verified.verifiedPaths).toEqual(['src/large.ts']);
  await builder.dispose();
}, 5_000);
