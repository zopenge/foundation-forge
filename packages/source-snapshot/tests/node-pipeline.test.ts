import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  exportRepositorySnapshot,
  planRepositorySnapshot,
  verifyPublishedSourceSnapshot,
  verifyRepositorySnapshotFreeze,
} from '../src/node.js';
import { addCommittedFile, createRepository, runGit } from './node-fixtures.js';

const roots: string[] = [];
const now = Date.parse('2026-09-15T00:00:00.000Z');
const policy = {
  sensitiveBasenames: ['.env'], sensitiveBasenamePrefixes: ['.env.'],
  excludedDirectoryNames: ['dist'], binaryExtensions: ['.png'],
  textExtensions: ['.ts'], textBasenames: ['.gitignore'],
};
const pack = { targetObjectBytes: 4096, maxObjectBytes: 8192, maxObjectCount: 50, maxObjectBytesTotal: 1_000_000 };
const groupForPath = (path: string): string => path.startsWith('src/') ? 'src' : 'root';
const options = (sourceRoot: string) => ({ sourceRoot, projectId: 'fixture-project', policyVersion: '1', publishedAt: now, policy, pack, groupForPath });
const createOutside = async (prefix: string): Promise<string> => { const root = await mkdtemp(join(tmpdir(), prefix)); roots.push(root); return root; };
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))); });
test('plans tracked and untracked source with caller-owned policy and grouping', async () => {
  const source = await createRepository(); roots.push(source);
  await addCommittedFile(source, 'src/a.ts');
  await mkdir(join(source, 'src'), { recursive: true });
  await writeFile(join(source, 'src', 'b.ts'), 'export const b = 1\n', 'utf8');
  await writeFile(join(source, '.env.local'), 'SECRET=value\n', 'utf8');
  const plan = await planRepositorySnapshot(options(source));
  expect(plan.status).toBe('READY');
  expect(plan.publishAllowed).toBe(true);
  expect(plan.includedPaths).toEqual(['.gitignore', 'src/a.ts', 'src/b.ts']);
  expect(plan.decisions.find(value => value.path === '.env.local')?.decision.ruleId).toBe('sensitive-path');
  expect(plan.bundle?.manifest.projectId).toBe('fixture-project');
  expect(plan.bundle?.textPackage.files.map(value => value.group)).toEqual(['root', 'src', 'src']);
  expect(plan.inventory.repositories[0]?.dirty).toBe(true);
});

test('plans an explicitly allowed checked-out submodule head and records gitlink provenance', async () => {
  const source = await createRepository(); const sub = await createRepository(); roots.push(source, sub);
  await addCommittedFile(sub, 'nested.ts');
  await runGit(source, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', sub, 'modules/lib']);
  await runGit(source, ['commit', '--quiet', '-am', 'submodule']);
  const parentGitlink = (await runGit(source, ['rev-parse', 'HEAD:modules/lib'])).trim();
  await writeFile(join(source, 'modules/lib/nested.ts'), 'changed\n', 'utf8');
  await runGit(join(source, 'modules/lib'), ['add', 'nested.ts']); await runGit(join(source, 'modules/lib'), ['commit', '--quiet', '-m', 'drift']);
  const actualHead = (await runGit(join(source, 'modules/lib'), ['rev-parse', 'HEAD'])).trim();
  const plan = await planRepositorySnapshot({ ...options(source), policy: { ...policy, textBasenames: [...policy.textBasenames, '.gitmodules'] }, submoduleHeadPolicy: 'allow-checked-out' });
  expect(plan.inventory.issues).toEqual([]);
  expect(plan.reviewEntries).toEqual([]);
  expect(plan.status).toBe('READY');
  expect(plan.bundle?.manifest.repositories).toContainEqual(expect.objectContaining({ path: 'modules/lib', head: actualHead, parentGitlink }));
});

test('freeze verification detects same-size source mutation after planning', async () => {
  const source = await createRepository(); roots.push(source);
  await writeFile(join(source, 'value.ts'), 'export const a = 1\n', 'utf8');
  const plan = await planRepositorySnapshot(options(source));
  expect(plan.publishAllowed).toBe(true);
  expect((await verifyRepositorySnapshotFreeze(options(source), plan.freeze)).ok).toBe(true);
  await writeFile(join(source, 'value.ts'), 'export const a = 2\n', 'utf8');
  const result = await verifyRepositorySnapshotFreeze(options(source), plan.freeze);
  expect(result.ok).toBe(false);
  expect(result.changedPaths).toEqual(['value.ts']);
});
test('blocks unknown file types and high-confidence secrets without echoing secret values', async () => {
  const source = await createRepository(); roots.push(source);
  await writeFile(join(source, 'unknown.custom'), 'opaque\n', 'utf8');
  const first = await planRepositorySnapshot(options(source));
  expect(first.status).toBe('BLOCKED');
  expect(first.reviewEntries.map(value => value.path)).toEqual(['unknown.custom']);
  expect(first.bundle).toBeNull();
  await rm(join(source, 'unknown.custom'));
  const secret = `ghp_${'A1b'.repeat(12)}`;
  await writeFile(join(source, 'leak.ts'), `export const token = '${secret}'\n`, 'utf8');
  const second = await planRepositorySnapshot(options(source));
  expect(second.status).toBe('BLOCKED');
  expect(second.secretFindings).toHaveLength(1);
  expect(JSON.stringify(second).includes(secret)).toBe(false);
  expect(second.bundle).toBeNull();
});

test('exports a ready repository, verifies publication and returns NO_CHANGES on repeat', async () => {
  const source = await createRepository(); roots.push(source);
  await addCommittedFile(source, 'src/a.ts');
  const target = await createOutside('snapshot-pipeline-target-');
  const state = await createOutside('snapshot-pipeline-state-');
  const exportOptions = { ...options(source), targetRoot: target, lockPath: join(state, 'publish.lock'), ownerId: 'fixture-owner', protectedTopLevelDirectories: ['notes'] };
  await mkdir(join(target, 'notes'));
  await writeFile(join(target, 'notes', 'keep.txt'), 'keep', 'utf8');
  const first = await exportRepositorySnapshot(exportOptions);
  expect(first.status).toBe('LOCAL_VERIFIED');
  if (first.status === 'BLOCKED') throw new Error('unexpected blocker');
  expect((await verifyPublishedSourceSnapshot({ targetRoot: target, ownerId: 'fixture-owner', protectedTopLevelDirectories: ['notes'] })).snapshotId).toBe(first.publication.snapshotId);
  expect(await import('node:fs/promises').then(fs => fs.readFile(join(target, 'notes', 'keep.txt'), 'utf8'))).toBe('keep');
  const second = await exportRepositorySnapshot({ ...exportOptions, publishedAt: now + 1_000 });
  expect(second.status).toBe('NO_CHANGES');
});
test('blocked export performs no target publication', async () => {
  const source = await createRepository(); roots.push(source);
  await writeFile(join(source, 'unknown.custom'), 'opaque\n', 'utf8');
  const target = await createOutside('snapshot-pipeline-blocked-');
  const state = await createOutside('snapshot-pipeline-blocked-state-');
  const result = await exportRepositorySnapshot({ ...options(source), targetRoot: target, lockPath: join(state, 'publish.lock'), ownerId: 'fixture-owner' });
  expect(result.status).toBe('BLOCKED');
  expect(existsSync(join(target, '.source-snapshot-owner.json'))).toBe(false);
  expect(existsSync(join(target, '00-SOURCE-SNAPSHOT.md'))).toBe(false);
});
