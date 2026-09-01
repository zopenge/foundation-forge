import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  scanChangedTextIntegrityFiles,
  scanTextIntegrityPaths,
} from '../src/node.js';
import {
  createTestDirectory,
  removeTestDirectory,
  runGit,
} from './fixtures.js';

const createdDirectories: string[] = [];
const corrupted = String.fromCodePoint(0x6d63, 0x8de8, 0x95b0);

const createRoot = async (): Promise<string> => {
  const root = await createTestDirectory();
  createdDirectories.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(createdDirectories.splice(0).map(removeTestDirectory));
});

describe('scanTextIntegrityPaths', () => {
  test('scans the AI and Runtime text type union with stable normalized ordering', async () => {
    const root = await createRoot();
    await writeFile(join(root, 'z-last.wgsl'), `// ${corrupted}\n`, 'utf8');
    await writeFile(join(root, 'a-first.cpp'), `// ${corrupted}\n`, 'utf8');
    await writeFile(join(root, 'Z-upper.ts'), `// ${corrupted}\n`, 'utf8');
    await writeFile(join(root, 'é-last.ts'), `// ${corrupted}\n`, 'utf8');
    await writeFile(join(root, 'CMakeLists.txt'), `# ${corrupted}\n`, 'utf8');
    await writeFile(join(root, 'image.png'), `not scanned ${corrupted}\n`, 'utf8');

    const issues = await scanTextIntegrityPaths(['.'], {
      cwd: root,
      respectGitIgnore: false,
    });

    expect(issues.map((issue) => issue.file)).toEqual([
      'CMakeLists.txt',
      'Z-upper.ts',
      'a-first.cpp',
      'z-last.wgsl',
      'é-last.ts',
    ]);
  });

  test('applies common directory ignores and consumer-specific path prefixes', async () => {
    const root = await createRoot();
    await mkdir(join(root, 'node_modules'), { recursive: true });
    await mkdir(join(root, 'tests', 'assets'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'bad.ts'), `// ${corrupted}\n`, 'utf8');
    await writeFile(join(root, 'tests', 'assets', 'bad.cpp'), `// ${corrupted}\n`, 'utf8');
    await writeFile(join(root, 'visible.ts'), 'const value = 1;\n', 'utf8');

    expect(await scanTextIntegrityPaths(['.'], {
      cwd: root,
      ignoredPathPrefixes: ['tests/assets/'],
      respectGitIgnore: false,
    })).toEqual([]);
  });

  test('respects ignore rules from the current and nested Git repositories', async () => {
    const root = await createRoot();
    await runGit(root, ['init']);
    await writeFile(join(root, '.gitignore'), 'ignored/\n', 'utf8');
    await mkdir(join(root, 'ignored'));
    await writeFile(join(root, 'ignored', 'bad.ts'), `// ${corrupted}\n`, 'utf8');
    const nested = join(root, 'modules', 'nested');
    await mkdir(nested, { recursive: true });
    await runGit(nested, ['init']);
    await writeFile(join(nested, '.gitignore'), 'tmp/\n', 'utf8');
    await mkdir(join(nested, 'tmp'));
    await writeFile(join(nested, 'tmp', 'bad.cpp'), `// ${corrupted}\n`, 'utf8');
    await writeFile(join(nested, 'visible.cpp'), `// ${corrupted}\n`, 'utf8');

    const issues = await scanTextIntegrityPaths(['.'], { cwd: root });

    expect(issues.map((issue) => issue.file)).toEqual(['modules/nested/visible.cpp']);
  });

  test('deduplicates overlapping paths and skips binary-looking text files', async () => {
    const root = await createRoot();
    await writeFile(join(root, 'bad.ts'), `// ${corrupted}\n`, 'utf8');
    await writeFile(join(root, 'binary.ts'), Buffer.from([0, 1, 2, 3]));

    const issues = await scanTextIntegrityPaths(['.', 'bad.ts'], {
      cwd: root,
      respectGitIgnore: false,
    });

    expect(issues.map((issue) => issue.file)).toEqual(['bad.ts']);
  });

  test('fails explicitly when an input path cannot be read', async () => {
    const root = await createRoot();

    await expect(scanTextIntegrityPaths(['missing'], { cwd: root }))
      .rejects.toThrow(/ENOENT/u);
  });
});

describe('scanChangedTextIntegrityFiles', () => {
  test('supports renamed targets and untracked files while skipping deleted and binary files', async () => {
    const root = await createRoot();
    await runGit(root, ['init']);
    await runGit(root, ['config', 'user.email', 'test@example.com']);
    await runGit(root, ['config', 'user.name', 'Test User']);
    await writeFile(join(root, 'renamed-from.ts'), 'const value = 1;\n', 'utf8');
    await writeFile(join(root, 'deleted.ts'), 'const value = 1;\n', 'utf8');
    await writeFile(join(root, 'binary.ts'), 'const value = 1;\n', 'utf8');
    await runGit(root, ['add', '.']);
    await runGit(root, ['commit', '-m', 'initial']);
    await rename(join(root, 'renamed-from.ts'), join(root, 'renamed.ts'));
    await writeFile(join(root, 'renamed.ts'), `// ${corrupted}\n`, 'utf8');
    await rm(join(root, 'deleted.ts'));
    await writeFile(join(root, 'binary.ts'), Buffer.from([0, 1, 2, 3]));
    await writeFile(join(root, 'untracked.cpp'), `// ${corrupted}\n`, 'utf8');

    const issues = await scanChangedTextIntegrityFiles({ cwd: root });

    expect(issues.map((issue) => issue.file)).toEqual(['renamed.ts', 'untracked.cpp']);
  });
});
