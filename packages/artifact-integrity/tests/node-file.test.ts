import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  calculateFileIntegrity,
  verifyFileIntegrity,
} from '../src/node.js';
import { createTestDirectory, removeTestDirectory } from './fixtures.js';

const abcSha256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const createdDirectories: string[] = [];

const createRoot = async (): Promise<string> => {
  const root = await createTestDirectory();
  createdDirectories.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(createdDirectories.splice(0).map(removeTestDirectory));
});

describe('Node file integrity', () => {
  test('calculates and verifies a regular file', async () => {
    const root = await createRoot();
    const file = join(root, 'artifact.bin');
    await writeFile(file, 'abc', 'utf8');

    await expect(calculateFileIntegrity(file)).resolves.toEqual({
      byteLength: 3,
      sha256: abcSha256,
    });
    await expect(verifyFileIntegrity(file, { byteLength: 3, sha256: abcSha256 }))
      .resolves.toEqual({ byteLength: 3, sha256: abcSha256 });
  });

  test('rejects directories and symbolic links', async () => {
    const root = await createRoot();
    const directory = join(root, 'directory');
    const file = join(root, 'artifact.bin');
    const link = join(root, 'artifact-link.bin');
    await mkdir(directory);
    await writeFile(file, 'abc', 'utf8');
    await symlink(file, link, 'file');

    await expect(calculateFileIntegrity(directory)).rejects.toMatchObject({
      code: 'NON_REGULAR_FILE',
    });
    await expect(calculateFileIntegrity(link)).rejects.toMatchObject({
      code: 'NON_REGULAR_FILE',
    });
  });

  test('fails explicitly when already aborted', async () => {
    const root = await createRoot();
    const file = join(root, 'artifact.bin');
    await writeFile(file, 'abc', 'utf8');
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    await expect(calculateFileIntegrity(file, { signal: controller.signal }))
      .rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
  });
});
