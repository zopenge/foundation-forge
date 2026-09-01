import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
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

export const runGit = async (cwd: string, args: readonly string[]): Promise<void> => {
  await execFileAsync('git', [...args], { cwd, encoding: 'utf8' });
};
