import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  resolveExistingPathWithinRoot,
  resolvePathWithinRoot,
} from '../src/node.js';
import { createTestDirectory, removeTestDirectory } from './fixtures.js';

const createdDirectories: string[] = [];

const createRoot = async (): Promise<string> => {
  const root = await createTestDirectory();
  createdDirectories.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(createdDirectories.splice(0).map(removeTestDirectory));
});

describe('lexical root containment', () => {
  test('resolves a portable path beneath an absolute root', async () => {
    const root = await createRoot();
    expect(resolvePathWithinRoot(root, '资料/file.txt')).toBe(resolve(root, '资料/file.txt'));
  });

  test.each([
    '../sibling/file.txt',
    '/absolute.txt',
    'C:/absolute.txt',
    '\\\\server\\share.txt',
  ])('rejects an escaping or absolute logical path: %s', async (logicalPath) => {
    const root = await createRoot();
    expect(() => resolvePathWithinRoot(root, logicalPath)).toThrowError(
      expect.objectContaining({ code: expect.stringMatching(/INVALID_RELATIVE_PATH|PATH_ESCAPE/u) }),
    );
  });
});

describe('existing-path root containment', () => {
  test('resolves a regular file and a symlink that remains beneath the root', async () => {
    const root = await createRoot();
    const directory = join(root, 'directory');
    const file = join(directory, 'file.txt');
    const link = join(root, 'inside-link.txt');
    await mkdir(directory);
    await writeFile(file, 'safe', 'utf8');
    await symlink(file, link, 'file');

    await expect(resolveExistingPathWithinRoot(root, 'directory/file.txt')).resolves.toBe(file);
    await expect(resolveExistingPathWithinRoot(root, 'inside-link.txt')).resolves.toBe(file);
  });

  test('rejects a symbolic link whose target escapes the root', async () => {
    const parent = await createRoot();
    const root = join(parent, 'root');
    const outside = join(parent, 'root-sibling.txt');
    const link = join(root, 'outside-link.txt');
    await mkdir(root);
    await writeFile(outside, 'outside', 'utf8');
    await symlink(outside, link, 'file');

    await expect(resolveExistingPathWithinRoot(root, 'outside-link.txt')).rejects.toMatchObject({
      code: 'PATH_ESCAPE',
    });
  });

  test('rejects a symbolic link that resolves to the root itself', async () => {
    const parent = await createRoot();
    const root = join(parent, 'root');
    const link = join(root, 'root-link');
    await mkdir(root);
    await symlink(root, link, 'junction');

    await expect(resolveExistingPathWithinRoot(root, 'root-link')).rejects.toMatchObject({
      code: 'PATH_ESCAPE',
    });
  });

  test('rejects a non-directory root and reports missing targets as I/O failures', async () => {
    const parent = await createRoot();
    const fileRoot = join(parent, 'root.txt');
    const directoryRoot = join(parent, 'root');
    await writeFile(fileRoot, 'not a directory', 'utf8');
    await mkdir(directoryRoot);

    await expect(resolveExistingPathWithinRoot(fileRoot, 'child.txt')).rejects.toMatchObject({
      code: 'ROOT_NOT_DIRECTORY',
    });
    await expect(resolveExistingPathWithinRoot(directoryRoot, 'missing.txt')).rejects.toMatchObject({
      code: 'PATH_IO_FAILED',
    });
  });
});
