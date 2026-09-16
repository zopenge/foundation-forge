import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { prepareRepositorySnapshot, publishPreparedSourceSnapshot, verifyPublishedSourceSnapshot } from '../src/node.js';
import { createRepository, runGit } from './node-fixtures.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))); });
const outside = async (prefix: string) => { const root = await mkdtemp(join(tmpdir(), prefix)); roots.push(root); return root; };
const pack = { targetObjectBytes: 4096, maxObjectBytes: 8192, maxObjectCount: 100, maxObjectBytesTotal: 4_000_000, textFormatVersion: 2 as const };
const prepare = async () => {
  const source = await createRepository(); roots.push(source);
  await mkdir(join(source, 'src'), { recursive: true });
  await writeFile(join(source, 'src/value.ts'), 'export const value = 1\n', 'utf8');
  await runGit(source, ['add', '.']); await runGit(source, ['commit', '--quiet', '-m', 'source']);
  const workRoot = await outside('prepared-publish-work-');
  const prepared = await prepareRepositorySnapshot({
    sourceRoot: source, projectId: 'prepared-publish', policyVersion: '1', publishedAt: 1,
    policy: { textExtensions: ['.ts'], textBasenames: ['.gitignore'] }, pack,
    groupForPath: path => path.startsWith('src/') ? 'src' : 'root', workRoot,
  });
  const manifest = prepared.plan.manifest;
  if (manifest === null) throw new Error('fixture did not prepare');
  return { source, prepared, manifest };
};
test('publishes prepared objects in a verified store and returns NO_CHANGES on repeat', async () => {
  const { source, prepared, manifest } = await prepare();
  const targetRoot = await outside('prepared-publish-target-');
  const stateRoot = await outside('prepared-publish-state-');
  await mkdir(join(targetRoot, 'notes'));
  await writeFile(join(targetRoot, 'notes/keep.txt'), 'keep', 'utf8');
  const options = {
    sourceRoot: source, targetRoot, lockPath: join(stateRoot, 'publish.lock'), ownerId: 'prepared-owner',
    protectedTopLevelDirectories: ['notes'],
  };
  const first = await publishPreparedSourceSnapshot({ manifest, objects: prepared.objects }, options);
  expect(first.status).toBe('LOCAL_VERIFIED');
  expect((await verifyPublishedSourceSnapshot({ targetRoot, ownerId: 'prepared-owner', level: 'text', protectedTopLevelDirectories: ['notes'] })).snapshotId)
    .toBe(manifest.snapshotId);
  expect(await readFile(join(targetRoot, 'notes/keep.txt'), 'utf8')).toBe('keep');
  const second = await publishPreparedSourceSnapshot({ manifest, objects: prepared.objects }, options);
  expect(second.status).toBe('NO_CHANGES');
  await prepared.dispose();
});

test('rejects corrupted prepared object bytes before switching the current entry', async () => {
  const { source, prepared, manifest } = await prepare();
  const targetRoot = await outside('prepared-corrupt-target-');
  const stateRoot = await outside('prepared-corrupt-state-');
  const firstObject = prepared.objects[0];
  if (firstObject === undefined) throw new Error('missing object');
  await writeFile(firstObject.spoolPath, 'corrupted', 'utf8');
  await expect(publishPreparedSourceSnapshot({ manifest, objects: prepared.objects }, {
    sourceRoot: source, targetRoot, lockPath: join(stateRoot, 'publish.lock'), ownerId: 'prepared-owner',
  })).rejects.toMatchObject({ code: 'OBJECT_INTEGRITY_MISMATCH' });
  expect(existsSync(join(targetRoot, '00-SOURCE-SNAPSHOT.md'))).toBe(false);
  await prepared.dispose();
});
