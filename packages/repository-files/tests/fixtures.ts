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
  return directory;
};

export const removeTestRepository = async (directory: string): Promise<void> => {
  if (!directory.startsWith(`${testRoot}\\`) && !directory.startsWith(`${testRoot}/`)) {
    throw new Error('test cleanup directory escaped the package cache');
  }
  await rm(directory, { force: true, recursive: true });
};

export const runGit = async (cwd: string, args: readonly string[]): Promise<string> => {
  const { stdout } = await execFileAsync('git', [...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_AUTHOR_NAME: 'Test User',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test User',
    },
  });
  return stdout;
};
