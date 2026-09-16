import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { readSnapshotText } from '../src/index.js';
import { prepareRepositorySnapshot } from '../src/node/prepared-pipeline.js';
import { createRepository, runGit } from './node-fixtures.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))); });
const makeOutside = async (prefix: string): Promise<string> => { const root = await mkdtemp(join(tmpdir(), prefix)); roots.push(root); return root; };
const pack = { targetObjectBytes: 4096, maxObjectBytes: 8192, maxObjectCount: 100, maxObjectBytesTotal: 4_000_000, textFormatVersion: 2 as const };
const policy = { textExtensions: ['.ts'], textBasenames: ['.gitignore'] };

test('prepares a repository snapshot through a disposable object spool', async () => {
  const source = await createRepository(); roots.push(source);
  await mkdir(join(source, 'src'), { recursive: true });
  await writeFile(join(source, 'src/a.ts'), 'export const a = 1\n', 'utf8');
  await writeFile(join(source, 'src/b.ts'), 'export const a = 1\n', 'utf8');
  await runGit(source, ['add', '.']); await runGit(source, ['commit', '--quiet', '-m', 'source']);
  const workRoot = await makeOutside('prepared-repository-work-');
  const prepared = await prepareRepositorySnapshot({
    sourceRoot: source, projectId: 'prepared-fixture', policyVersion: '1', publishedAt: 1,
    policy, pack, groupForPath: path => path.startsWith('src/') ? 'src' : 'root', workRoot,
  });
  expect(prepared.plan.status).toBe('READY');
  expect(prepared.plan.publishAllowed).toBe(true);
  expect(prepared.plan.manifest?.files.map(file => file.path)).toEqual(['.gitignore', 'src/a.ts', 'src/b.ts']);
  expect(prepared.objects.length).toBeGreaterThan(0);
  const manifest = prepared.plan.manifest;
  if (manifest === null) throw new Error('missing prepared manifest');
  const file = manifest.files.find(candidate => candidate.path === 'src/a.ts');
  if (file === undefined) throw new Error('missing source file');
  const required = new Set(file.objectPaths);
  const objectBytes = [];
  for (const object of prepared.objects.filter(candidate => required.has(candidate.path))) {
    objectBytes.push({ path: object.path, bytes: await readFile(object.spoolPath) });
  }
  const text = await readSnapshotText(manifest, objectBytes, 'src/a.ts', {
    maxObjectBytes: 8192, maxFileBytes: 100_000, maxTotalBytes: 4_000_000,
  });
  expect(text.text).toBe('export const a = 1\n');
  const spoolRoot = prepared.spoolRoot;
  expect(existsSync(spoolRoot)).toBe(true);
  await prepared.dispose();
  expect(existsSync(spoolRoot)).toBe(false);
});

test('prepared planning remains blocked by secret findings without materializing a manifest', async () => {
  const source = await createRepository(); roots.push(source);
  const secret = `ghp_${'A1b'.repeat(12)}`;
  await writeFile(join(source, 'leak.ts'), `export const token = '${secret}'\n`, 'utf8');
  const workRoot = await makeOutside('prepared-blocked-work-');
  const prepared = await prepareRepositorySnapshot({
    sourceRoot: source, projectId: 'prepared-fixture', policyVersion: '1', publishedAt: 1,
    policy, pack, groupForPath: () => 'root', workRoot,
  });
  expect(prepared.plan.status).toBe('BLOCKED');
  expect(prepared.plan.secretFindings).toHaveLength(1);
  expect(prepared.plan.manifest).toBeNull();
  await prepared.dispose();
});

test('rejects a prepared work root inside the source repository', async () => {
  const source = await createRepository(); roots.push(source);
  await writeFile(join(source, 'value.ts'), 'export const value = 1\n', 'utf8');
  await expect(prepareRepositorySnapshot({
    sourceRoot: source, projectId: 'prepared-fixture', policyVersion: '1', publishedAt: 1,
    policy, pack, groupForPath: () => 'root', workRoot: join(source, '.snapshot-work'),
  })).rejects.toMatchObject({ code: 'SOURCE_TARGET_OVERLAP' });
});
