import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const testRoot = resolve(import.meta.dirname, '..', '.tmp', 'tests');

export const createTestRepository = async (): Promise<string> => {
  const directory = resolve(testRoot, randomUUID());
  await mkdir(directory, { recursive: true });
  await runGit(directory, ['init', '--quiet']);
  await runGit(directory, ['config', 'user.email', 'test@example.com']);
  await runGit(directory, ['config', 'user.name', 'Test User']);
  return directory;
};

export const removeTestRepository = async (directory: string): Promise<void> => {
  if (!directory.startsWith(`${testRoot}\\`) && !directory.startsWith(`${testRoot}/`)) {
    throw new Error('test cleanup directory escaped the package cache');
  }
  await rm(directory, { force: true, recursive: true });
};

export const runGit = async (cwd: string, args: readonly string[]): Promise<void> => {
  await execFileAsync('git', [...args], { cwd, encoding: 'utf8' });
};
