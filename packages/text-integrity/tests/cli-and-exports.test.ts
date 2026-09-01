import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { inspectTextIntegrity } from '../src/index.js';
import { runTextIntegrityCli } from '../src/node.js';
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

describe('Text Integrity CLI', () => {
  test('rejects mixed changed mode and explicit paths', async () => {
    await expect(runTextIntegrityCli(['--changed', 'src']))
      .rejects.toThrow('TEXT_INTEGRITY_ARGUMENT_CONFLICT');
  });

  test('requires a path when no defaults are configured', async () => {
    await expect(runTextIntegrityCli([]))
      .rejects.toThrow('TEXT_INTEGRITY_PATH_REQUIRED');
  });

  test('uses configured defaults and returns deterministic exit codes', async () => {
    const root = await createRoot();
    const output: string[] = [];
    await writeFile(join(root, 'ok.ts'), 'const value = 1;\n', 'utf8');

    expect(await runTextIntegrityCli([], {
      cwd: root,
      defaultPaths: ['.'],
      writeError: (message) => output.push(message),
    })).toBe(0);

    await writeFile(join(root, 'bad.md'), 'broken ???\n', 'utf8');
    expect(await runTextIntegrityCli(['--', '.'], {
      cwd: root,
      respectGitIgnore: false,
      writeError: (message) => output.push(message),
    })).toBe(1);
    expect(output).toEqual(['bad.md:1: question-placeholder: broken ???']);
  });
});

describe('Text Integrity public entries', () => {
  test('keeps the root entry runtime-neutral and side-effect free', async () => {
    const first = await import('../src/index.js');
    const second = await import('../src/index.js');

    expect(Object.keys(first)).toEqual(['inspectTextIntegrity']);
    expect(second.inspectTextIntegrity).toBe(first.inspectTextIntegrity);
    expect(inspectTextIntegrity('safe')).toEqual([]);
  });

  test('exports only the Node scanning surface from the Node entry', async () => {
    const nodeEntry = await import('../src/node.js');

    expect(Object.keys(nodeEntry).sort()).toEqual([
      'runTextIntegrityCli',
      'scanChangedTextIntegrityFiles',
      'scanTextIntegrityPaths',
    ]);
  });
});
