import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  RepositoryFilesError,
  filterIgnoredRepositoryPaths,
  findRepositoryRoot,
  listChangedRepositoryFiles,
  listRepositoryFiles,
  normalizeRepositoryPath,
} from '../src/index.js';
import {
  withTestRepositories,
  type RepositoryFixture,
} from './fixtures.js';

const repositoryTest = (name: string, body: (fixture: RepositoryFixture) => Promise<void>) =>
  test(name, context => withTestRepositories(context, body), 15_000);

describe('repository discovery', () => {
  repositoryTest('pins fixture Git identities independently of inherited user configuration', async ({ createRoot, runGit }) => {
    const root = await createRoot();
    const emptyUser = ['-c', 'user.name=', '-c', 'user.email='];
    for (const identity of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
      expect(await runGit(root, [...emptyUser, 'var', identity])).toMatch(/^Test User <test@example\.com> /u);
    }
    await runGit(root, [...emptyUser, 'commit', '--allow-empty', '--quiet', '-m', 'fixture identity']);
  });

  repositoryTest('lists tracked and untracked non-ignored files with stable normalized paths', async ({ createRoot, runGit, signal }) => {
    const root = await createRoot();
    await writeFile(join(root, '.gitignore'), 'ignored/\n', 'utf8');
    await mkdir(join(root, 'ignored'));
    await writeFile(join(root, 'ignored', 'hidden.ts'), '', 'utf8');
    await writeFile(join(root, 'z-last.ts'), '', 'utf8');
    await writeFile(join(root, 'a tracked.ts'), '', 'utf8');
    await runGit(root, ['add', '.gitignore', 'a tracked.ts']);

    await expect(listRepositoryFiles({ cwd: root, signal })).resolves.toEqual([
      '.gitignore',
      'a tracked.ts',
      'z-last.ts',
    ]);
    await expect(findRepositoryRoot(join(root, 'ignored'), { signal })).resolves.toBe(root);
  });

  repositoryTest('fails explicitly outside a Git repository', async ({ createRoot, signal }) => {
    const root = await createRoot();
    const outside = join(root, 'outside');
    await mkdir(outside);
    const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = root;
    try {
      await expect(findRepositoryRoot(outside, { signal })).rejects.toMatchObject({
        code: 'REPOSITORY_NOT_FOUND',
      });
    } finally {
      if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
    }
  });

  repositoryTest('recursively lists tracked and untracked files from initialized submodules', async ({ createRoot, runGit, signal }) => {
    const root = await createRoot();
    const submodule = join(root, 'modules', 'nested');
    await mkdir(submodule, { recursive: true });
    await runGit(submodule, ['init', '--quiet']);
    await writeFile(join(submodule, 'tracked.ts'), '', 'utf8');
    await runGit(submodule, ['add', 'tracked.ts']);
    await runGit(submodule, ['commit', '--quiet', '-m', 'initial']);
    const commit = (await runGit(submodule, ['rev-parse', 'HEAD'])).trim();
    await writeFile(join(root, '.gitmodules'), [
      '[submodule "modules/nested"]',
      '\tpath = modules/nested',
      '\turl = ./modules/nested',
      '',
    ].join('\n'), 'utf8');
    await runGit(root, ['add', '.gitmodules']);
    await runGit(root, ['update-index', '--add', '--cacheinfo', `160000,${commit},modules/nested`]);
    await writeFile(join(root, 'root-untracked.ts'), '', 'utf8');
    await writeFile(join(root, 'modules', 'nested', 'nested-untracked.ts'), '', 'utf8');

    await expect(listRepositoryFiles({ cwd: root, recurseSubmodules: true, signal })).resolves.toEqual([
      '.gitmodules',
      'modules/nested/nested-untracked.ts',
      'modules/nested/tracked.ts',
      'root-untracked.ts',
    ]);
  });
});

describe('changed repository files', () => {
  repositoryTest('returns rename targets and untracked files while excluding deleted paths', async ({ createRoot, runGit, signal }) => {
    const root = await createRoot();
    await writeFile(join(root, 'renamed-from.ts'), '', 'utf8');
    await writeFile(join(root, 'deleted.ts'), '', 'utf8');
    await runGit(root, ['add', '.']);
    await runGit(root, ['commit', '--quiet', '-m', 'initial']);
    await runGit(root, ['mv', 'renamed-from.ts', 'renamed.ts']);
    await rm(join(root, 'deleted.ts'));
    await writeFile(join(root, 'untracked.ts'), '', 'utf8');

    await expect(listChangedRepositoryFiles({ cwd: root, signal })).resolves.toEqual([
      'renamed.ts',
      'untracked.ts',
    ]);
    await expect(listChangedRepositoryFiles({ cwd: root, includeDeleted: true, signal })).resolves.toEqual([
      'deleted.ts',
      'renamed.ts',
      'untracked.ts',
    ]);
  });

  repositoryTest('observes an already-aborted signal', async ({ createRoot }) => {
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
  repositoryTest('respects the current and nested repository ignore rules', async ({ createRoot, runGit, signal }) => {
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

    await expect(filterIgnoredRepositoryPaths(paths, { cwd: root, signal }))
      .resolves.toEqual(['modules/nested/visible.ts']);
  });
});
