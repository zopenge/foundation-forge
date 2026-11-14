import * as files from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { addCommittedFile, createRepository, removeRepository, runGit } from './node-fixtures.js';

vi.mock('node:fs/promises', async original => ({ ...await original<typeof files>() }));
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(removeRepository)); });

test('initial files form one real clean commit and later commits and clones remain independent', async () => {
  const options = { files: { 'src/a.ts': 'export const a = 1\n', '目录/file.txt': 'fixture\n' } };
  const a = await createRepository(options), b = await createRepository(options); roots.push(a, b);
  expect((await runGit(a, ['rev-list', '--count', 'HEAD'])).trim()).toBe('1');
  expect((await runGit(a, ['status', '--porcelain'])).trim()).toBe('');
  expect(await runGit(a, ['show', 'HEAD:src/a.ts'])).toBe('export const a = 1\n');
  expect(await runGit(a, ['show', 'HEAD:目录/file.txt'])).toBe('fixture\n');
  expect((await files.lstat(join(a, '.git'), { bigint: true })).ino).not.toBe((await files.lstat(join(b, '.git'), { bigint: true })).ino);
  await addCommittedFile(a, 'next.ts', 'next\n');
  expect((await runGit(a, ['rev-list', '--count', 'HEAD'])).trim()).toBe('2');
  expect((await runGit(b, ['rev-list', '--count', 'HEAD'])).trim()).toBe('1');
  const clone = join(a, 'clone'); await runGit(a, ['clone', '--quiet', '--local', b, clone]);
  expect(await runGit(clone, ['show', 'HEAD:src/a.ts'])).toBe('export const a = 1\n');
  expect((await files.readFile(join(clone, 'src/a.ts'), 'utf8')).replaceAll('\r\n', '\n')).toBe('export const a = 1\n');
});

test.each(['../escape', '/absolute', 'C:/absolute', '.git/config', 'src/../../escape', 'a\nb', 'a\\b'])(
  'initial file %s cannot escape or rewrite Git metadata', async path => {
    await expect(createRepository({ files: { [path]: 'unsafe' } })).rejects.toThrow('FIXTURE_PATH');
  });

test('preparation failure removes only its newly created root and preserves the original error', async () => {
  const mkdtemp = vi.spyOn(files, 'mkdtemp'), original = files.writeFile, failure = new Error('fixture write failed');
  vi.spyOn(files, 'writeFile').mockImplementation(async (...args) => {
    if (String(args[0]).endsWith('broken.ts')) throw failure;
    return original(...args);
  });
  await expect(createRepository({ files: { 'broken.ts': 'broken' } })).rejects.toBe(failure);
  const created = await mkdtemp.mock.results[0]?.value;
  expect(typeof created).toBe('string');
  await expect(files.lstat(created)).rejects.toMatchObject({ code: 'ENOENT' });
});
