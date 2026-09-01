import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const testRoot = resolve(import.meta.dirname, '..', '.tmp', 'tests');

export const createTestDirectory = async (): Promise<string> => {
  const directory = resolve(testRoot, randomUUID());
  await mkdir(directory, { recursive: true });
  return directory;
};

export const removeTestDirectory = async (directory: string): Promise<void> => {
  if (!directory.startsWith(`${testRoot}\\`) && !directory.startsWith(`${testRoot}/`)) {
    throw new Error('test cleanup directory escaped the package cache');
  }
  await rm(directory, { force: true, recursive: true });
};
