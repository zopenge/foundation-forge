import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  RepositoryFilesError,
  filterIgnoredRepositoryPaths,
  findRepositoryRoot,
  listChangedRepositoryFiles,
  listRepositoryFiles,
  normalizeRepositoryPath,
} from '../src/index.js';
import {
  createTestRepository,
  removeTestRepository,
  runGit,
} from './fixtures.js';

const createdRepositories: string[] = [];

const createRoot = async (): Promise<string> => {
  const root = await createTestRepository();
  createdRepositories.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(createdRepositories.splice(0).map(removeTestRepository));
});

describe('repository discovery', () => {
  test('lists tracked and untracked non-ignored files with stable normalized paths', async () => {
    const root = await createRoot();
    await writeFile(join(root, '.gitignore'), 'ignored/\n', 'utf8');
    await mkdir(join(root, 'ignored'));
    await writeFile(join(root, 'ignored', 'hidden.ts'), '', 'utf8');
    await writeFile(join(root, 'z-last.ts'), '', 'utf8');
    await writeFile(join(root, 'a tracked.ts'), '', 'utf8');
    await runGit(root, ['add', '.gitignore', 'a tracked.ts']);

    await expect(listRepositoryFiles({ cwd: root })).resolves.toEqual([
      '.gitignore',
      'a tracked.ts',
      'z-last.ts',
    ]);
    await expect(findRepositoryRoot(join(root, 'ignored'))).resolves.toBe(root);
  });

  test('fails explicitly outside a Git repository', async () => {
    const root = await createRoot();
    const outside = join(root, 'outside');
    await mkdir(outside);
    const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = root;
    try {
      await expect(findRepositoryRoot(outside)).rejects.toMatchObject({
        code: 'REPOSITORY_NOT_FOUND',
      });
    } finally {
      if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
    }
  });

  test('recursively lists tracked and untracked files from initialized submodules', async () => {
    const root = await createRoot();
    const submodule = await createRoot();
    await writeFile(join(submodule, 'tracked.ts'), '', 'utf8');
    await runGit(submodule, ['add', 'tracked.ts']);
    await runGit(submodule, ['commit', '--quiet', '-m', 'initial']);
    await runGit(root, [
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '--quiet',
      submodule,
      'modules/nested',
    ]);
    await writeFile(join(root, 'root-untracked.ts'), '', 'utf8');
    await writeFile(join(root, 'modules', 'nested', 'nested-untracked.ts'), '', 'utf8');

    await expect(listRepositoryFiles({ cwd: root, recurseSubmodules: true })).resolves.toEqual([
      '.gitmodules',
      'modules/nested/nested-untracked.ts',
      'modules/nested/tracked.ts',
      'root-untracked.ts',
    ]);
  });
});

describe('changed repository files', () => {
  test('returns rename targets and untracked files while excluding deleted paths', async () => {
    const root = await createRoot();
    await writeFile(join(root, 'renamed-from.ts'), '', 'utf8');
    await writeFile(join(root, 'deleted.ts'), '', 'utf8');
    await runGit(root, ['add', '.']);
    await runGit(root, ['commit', '--quiet', '-m', 'initial']);
    await runGit(root, ['mv', 'renamed-from.ts', 'renamed.ts']);
    await rm(join(root, 'deleted.ts'));
    await writeFile(join(root, 'untracked.ts'), '', 'utf8');

    await expect(listChangedRepositoryFiles({ cwd: root })).resolves.toEqual([
      'renamed.ts',
      'untracked.ts',
    ]);
    await expect(listChangedRepositoryFiles({ cwd: root, includeDeleted: true })).resolves.toEqual([
      'deleted.ts',
      'renamed.ts',
      'untracked.ts',
    ]);
  });

  test('observes an already-aborted signal', async () => {
    const root = await createRoot();
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    await expect(listChangedRepositoryFiles({ cwd: root, signal: controller.signal }))
      .rejects.toBeInstanceOf(RepositoryFilesError);
    await expect(listChangedRepositoryFiles({ cwd: root, signal: controller.signal }))
      .rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
  });
});

describe('ignore filtering', () => {
  test('respects the current and nested repository ignore rules', async () => {
    const root = await createRoot();
    await writeFile(join(root, '.gitignore'), 'ignored/\n', 'utf8');
    await mkdir(join(root, 'ignored'));
    await writeFile(join(root, 'ignored', 'root.ts'), '', 'utf8');
    const nested = join(root, 'modules', 'nested');
    await mkdir(nested, { recursive: true });
    await runGit(nested, ['init', '--quiet']);
    await writeFile(join(nested, '.gitignore'), 'tmp/\n', 'utf8');
    await mkdir(join(nested, 'tmp'));
    await writeFile(join(nested, 'tmp', 'nested.ts'), '', 'utf8');
    await writeFile(join(nested, 'visible.ts'), '', 'utf8');

    const paths = [
      join(root, 'ignored', 'root.ts'),
      join(nested, 'tmp', 'nested.ts'),
      join(nested, 'visible.ts'),
    ].map((path) => normalizeRepositoryPath(relative(root, path)));

    await expect(filterIgnoredRepositoryPaths(paths, { cwd: root }))
      .resolves.toEqual(['modules/nested/visible.ts']);
  });
});
