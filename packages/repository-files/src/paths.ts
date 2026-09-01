import { isAbsolute, relative, resolve } from 'node:path';

import { repositoryFilesErrorCodes } from './contracts.js';
import { RepositoryFilesError } from './errors.js';

export const normalizeRepositoryPath = (path: string): string => path.replaceAll('\\', '/');

export const compareRepositoryPaths = (left: string, right: string): number => {
  if (left < right) return -1;
  return left > right ? 1 : 0;
};

export const normalizeInputRepositoryPath = (cwd: string, path: string): string => {
  if (path.length === 0) {
    throw new RepositoryFilesError(repositoryFilesErrorCodes.invalidPath, { path });
  }
  const normalized = normalizeRepositoryPath(relative(cwd, resolve(cwd, path)));
  if (normalized === '..' || normalized.startsWith('../') || isAbsolute(normalized)) {
    throw new RepositoryFilesError(repositoryFilesErrorCodes.invalidPath, { path });
  }
  return normalized;
};

export const uniqueSortedRepositoryPaths = (paths: readonly string[]): readonly string[] => (
  [...new Set(paths.map(normalizeRepositoryPath))].sort(compareRepositoryPaths)
);
