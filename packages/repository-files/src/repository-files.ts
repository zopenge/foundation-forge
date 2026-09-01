import { stat } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

import {
  repositoryFilesErrorCodes,
  type ChangedRepositoryFilesOptions,
  type RepositoryFilesOptions,
  type RepositoryOperationOptions,
  type RepositoryPathFilterOptions,
} from './contracts.js';
import { RepositoryFilesError } from './errors.js';
import { runGitCommand } from './git-process.js';
import {
  normalizeInputRepositoryPath,
  normalizeRepositoryPath,
  uniqueSortedRepositoryPaths,
} from './paths.js';

export const findRepositoryRoot = async (
  startPath = process.cwd(),
  options: RepositoryOperationOptions = {},
): Promise<string> => {
  const resolved = resolve(startPath);
  let directory = resolved;
  try {
    if ((await stat(resolved)).isFile()) directory = dirname(resolved);
  } catch (error) {
    throw new RepositoryFilesError(repositoryFilesErrorCodes.invalidPath, { path: startPath }, error);
  }
  try {
    const output = await runGitCommand(['rev-parse', '--show-toplevel'], {
      cwd: directory,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return resolve(output.trim());
  } catch (error) {
    if (
      error instanceof RepositoryFilesError
      && error.code === repositoryFilesErrorCodes.gitCommandFailed
      && error.details.exitCode === 128
    ) {
      throw new RepositoryFilesError(
        repositoryFilesErrorCodes.repositoryNotFound,
        { path: startPath },
        error,
      );
    }
    throw error;
  }
};

export const listRepositoryFiles = async (
  options: RepositoryFilesOptions = {},
): Promise<readonly string[]> => {
  const cwd = resolve(options.cwd ?? process.cwd());
  const root = await findRepositoryRoot(cwd, options);
  const args = ['ls-files', '--cached', '--others', '--exclude-standard', '-z'];
  if (options.recurseSubmodules === true) args.push('--recurse-submodules');
  const output = await runGitCommand(args, {
    cwd: root,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return uniqueSortedRepositoryPaths(output.split('\0').filter((path) => path.length > 0));
};

export const listChangedRepositoryFiles = async (
  options: ChangedRepositoryFilesOptions = {},
): Promise<readonly string[]> => {
  const cwd = resolve(options.cwd ?? process.cwd());
  const root = await findRepositoryRoot(cwd, options);
  const output = await runGitCommand(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    {
      cwd: root,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );
  return uniqueSortedRepositoryPaths(parseChangedPaths(output, options.includeDeleted === true));
};

export const filterIgnoredRepositoryPaths = async (
  paths: readonly string[],
  options: RepositoryPathFilterOptions = {},
): Promise<readonly string[]> => {
  const cwd = resolve(options.cwd ?? process.cwd());
  const normalizedPaths = uniqueSortedRepositoryPaths(
    paths.map((path) => normalizeInputRepositoryPath(cwd, path)),
  );
  const rootCache = new Map<string, string | undefined>();
  const groups = new Map<string, Array<{ readonly input: string; readonly repositoryPath: string }>>();
  const retained = new Set<string>();

  for (const path of normalizedPaths) {
    const absolutePath = resolve(cwd, path);
    const start = dirname(absolutePath);
    let root = rootCache.get(start);
    if (!rootCache.has(start)) {
      try {
        root = await findRepositoryRoot(start, options);
      } catch (error) {
        if (error instanceof RepositoryFilesError && error.code === repositoryFilesErrorCodes.repositoryNotFound) {
          root = undefined;
        } else {
          throw error;
        }
      }
      rootCache.set(start, root);
    }
    if (root === undefined) {
      retained.add(path);
      continue;
    }
    const group = groups.get(root) ?? [];
    group.push({
      input: path,
      repositoryPath: normalizeRepositoryPath(relative(root, absolutePath)),
    });
    groups.set(root, group);
  }

  for (const [root, group] of groups) {
    const ignoredOutput = await runGitCommand(['check-ignore', '-z', '--stdin'], {
      allowedExitCodes: new Set([1]),
      cwd: root,
      input: `${group.map((item) => item.repositoryPath).join('\0')}\0`,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const ignored = new Set(ignoredOutput.split('\0').filter((path) => path.length > 0));
    for (const item of group) {
      if (!ignored.has(item.repositoryPath)) retained.add(item.input);
    }
  }
  return uniqueSortedRepositoryPaths([...retained]);
};

const parseChangedPaths = (output: string, includeDeleted: boolean): readonly string[] => {
  const paths: string[] = [];
  const entries = output.split('\0');
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined || entry.length === 0) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (includeDeleted || !status.includes('D')) paths.push(path);
    if (status[0] === 'R' || status[0] === 'C') index += 1;
  }
  return paths;
};
