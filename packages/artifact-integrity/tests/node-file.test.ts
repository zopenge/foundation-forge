import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  calculateBytesIntegritySync,
  calculateFileIntegrity,
  calculateFileIntegritySync,
  verifyBytesIntegritySync,
  verifyFileIntegrity,
  verifyFileIntegritySync,
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
  test('calculates and verifies bytes synchronously', () => {
    const bytes = new TextEncoder().encode('abc');

    expect(calculateBytesIntegritySync(bytes)).toEqual({
      byteLength: 3,
      sha256: abcSha256,
    });
    expect(verifyBytesIntegritySync(bytes, { byteLength: 3, sha256: abcSha256 }))
      .toEqual({ byteLength: 3, sha256: abcSha256 });
  });

  test('reports synchronous byte mismatches with normalized diagnostics', () => {
    const bytes = new TextEncoder().encode('abc');

    expect(() => verifyBytesIntegritySync(bytes, {
      byteLength: 4,
      sha256: abcSha256.toUpperCase(),
    })).toThrowError(expect.objectContaining({
      code: 'INTEGRITY_MISMATCH',
      details: {
        actualByteLength: 3,
        actualSha256: abcSha256,
        expectedByteLength: 4,
        expectedSha256: abcSha256,
      },
    }));
  });

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
    expect(calculateFileIntegritySync(file)).toEqual({
      byteLength: 3,
      sha256: abcSha256,
    });
    expect(verifyFileIntegritySync(file, { byteLength: 3, sha256: abcSha256 }))
      .toEqual({ byteLength: 3, sha256: abcSha256 });
  });

  test('calculates a file larger than one synchronous read buffer', async () => {
    const root = await createRoot();
    const file = join(root, 'large-artifact.bin');
    const bytes = new Uint8Array(200_000).fill(0x61);
    await writeFile(file, bytes);

    expect(calculateFileIntegritySync(file)).toEqual(calculateBytesIntegritySync(bytes));
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
    expect(() => calculateFileIntegritySync(directory)).toThrowError(
      expect.objectContaining({ code: 'NON_REGULAR_FILE' }),
    );
    expect(() => calculateFileIntegritySync(link)).toThrowError(
      expect.objectContaining({ code: 'NON_REGULAR_FILE' }),
    );
  });

  test('reports synchronous file I/O failures explicitly', async () => {
    const root = await createRoot();
    const missing = join(root, 'missing.bin');

    expect(() => calculateFileIntegritySync(missing)).toThrowError(
      expect.objectContaining({ code: 'FILE_IO_FAILED' }),
    );
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
