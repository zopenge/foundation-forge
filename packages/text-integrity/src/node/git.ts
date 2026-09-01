import { execFile, spawn } from 'node:child_process';
import { dirname, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { TextIntegrityScanConfiguration } from './configuration.js';
import {
  compareNormalizedPaths,
  isIgnoredPath,
  isTextFile,
  normalizeRepoPath,
} from './paths.js';

const execFileAsync = promisify(execFile);

export const filterGitRelevantFiles = async (
  files: readonly string[],
): Promise<readonly string[]> => {
  const rootCache = new Map<string, string | undefined>();
  const filesByRoot = new Map<string, string[]>();
  const nonGitFiles: string[] = [];

  for (const file of files) {
    const root = await findGitRoot(dirname(file), rootCache);
    if (root === undefined) {
      nonGitFiles.push(file);
      continue;
    }
    const group = filesByRoot.get(root) ?? [];
    group.push(file);
    filesByRoot.set(root, group);
  }

  const filtered = [...nonGitFiles];
  for (const [root, rootFiles] of filesByRoot) {
    const relativePaths = rootFiles.map((file) => normalizeRepoPath(relative(root, file)));
    const ignoredPaths = await collectGitIgnoredPaths(root, relativePaths);
    for (const [index, file] of rootFiles.entries()) {
      const relativePath = relativePaths[index];
      if (relativePath !== undefined && !ignoredPaths.has(relativePath)) {
        filtered.push(file);
      }
    }
  }
  return filtered.sort((left, right) => compareNormalizedPaths(
    normalizeRepoPath(left),
    normalizeRepoPath(right),
  ));
};

export const collectChangedTextFiles = async (
  cwd: string,
  configuration: TextIntegrityScanConfiguration,
): Promise<readonly string[]> => {
  const { stdout } = await execFileAsync(
    'git',
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { cwd, encoding: 'utf8', maxBuffer: 16 * 1_024 * 1_024 },
  );
  const files = parseGitStatusPorcelain(stdout)
    .map((filePath) => resolve(cwd, filePath))
    .filter((filePath) => !isIgnoredPath(filePath, cwd, configuration))
    .filter((filePath) => isTextFile(filePath, configuration));

  return [...new Set(files)].sort((left, right) => compareNormalizedPaths(
    normalizeRepoPath(relative(cwd, left)),
    normalizeRepoPath(relative(cwd, right)),
  ));
};

const parseGitStatusPorcelain = (output: string): readonly string[] => {
  const paths: string[] = [];
  const entries = output.split('\0');

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined || entry.length === 0) {
      continue;
    }
    const status = entry.slice(0, 2);
    const filePath = entry.slice(3);
    if (!status.includes('D')) {
      paths.push(filePath);
    }
    if (status[0] === 'R' || status[0] === 'C') {
      index += 1;
    }
  }
  return paths;
};

const findGitRoot = async (
  directory: string,
  cache: Map<string, string | undefined>,
): Promise<string | undefined> => {
  const resolvedDirectory = resolve(directory);
  if (cache.has(resolvedDirectory)) {
    return cache.get(resolvedDirectory);
  }

  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--show-toplevel'],
      { cwd: resolvedDirectory, encoding: 'utf8', maxBuffer: 1_024 * 1_024 },
    );
    const root = resolve(stdout.trim());
    cache.set(resolvedDirectory, root);
    return root;
  } catch (error) {
    if (isExitCode(error, 128)) {
      cache.set(resolvedDirectory, undefined);
      return undefined;
    }
    throw error;
  }
};

const collectGitIgnoredPaths = (
  root: string,
  relativePaths: readonly string[],
): Promise<ReadonlySet<string>> => new Promise((resolvePromise, reject) => {
  if (relativePaths.length === 0) {
    resolvePromise(new Set());
    return;
  }

  const child = spawn('git', ['check-ignore', '-z', '--stdin'], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
  child.on('error', reject);
  child.on('close', (code) => {
    if (code !== 0 && code !== 1) {
      const diagnostic = Buffer.concat(stderrChunks).toString('utf8').trim();
      reject(new Error(diagnostic || `git check-ignore failed with exit code ${String(code)}`));
      return;
    }
    const output = Buffer.concat(stdoutChunks).toString('utf8');
    resolvePromise(new Set(output.split('\0').filter((path) => path.length > 0)));
  });
  child.stdin.end(`${relativePaths.join('\0')}\0`, 'utf8');
});

const isExitCode = (error: unknown, expected: number): boolean => {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  return error.code === expected;
};
