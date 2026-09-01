import { readdir, stat } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';

import type { TextIntegrityScanConfiguration } from './configuration.js';

export const collectTextFiles = async (
  paths: readonly string[],
  cwd: string,
  configuration: TextIntegrityScanConfiguration,
): Promise<readonly string[]> => {
  const files = new Set<string>();

  for (const path of paths) {
    await collectPath(resolve(cwd, path), cwd, configuration, files);
  }
  return [...files].sort((left, right) => compareNormalizedPaths(
    normalizeRepoPath(relative(cwd, left)),
    normalizeRepoPath(relative(cwd, right)),
  ));
};

export const isTextFile = (
  filePath: string,
  configuration: TextIntegrityScanConfiguration,
): boolean => configuration.textFileNames.has(basename(filePath))
  || configuration.textExtensions.has(extname(filePath).toLowerCase());

export const isIgnoredPath = (
  filePath: string,
  cwd: string,
  configuration: TextIntegrityScanConfiguration,
): boolean => {
  const repoPath = normalizeRepoPath(relative(cwd, filePath));
  const segments = repoPath.split('/');

  return segments.some((segment) => configuration.ignoredDirectoryNames.has(segment))
    || configuration.ignoredPathPrefixes.some((prefix) => (
      repoPath === prefix || repoPath.startsWith(`${prefix}/`)
    ));
};

export const normalizeRepoPath = (path: string): string => path.replaceAll('\\', '/');

export const compareNormalizedPaths = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
};

const collectPath = async (
  filePath: string,
  cwd: string,
  configuration: TextIntegrityScanConfiguration,
  files: Set<string>,
): Promise<void> => {
  if (isIgnoredPath(filePath, cwd, configuration)) {
    return;
  }

  const fileStat = await stat(filePath);
  if (fileStat.isDirectory()) {
    const entries = await readdir(filePath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isFile()) {
        continue;
      }
      await collectPath(join(filePath, entry.name), cwd, configuration, files);
    }
    return;
  }
  if (fileStat.isFile() && isTextFile(filePath, configuration)) {
    files.add(resolve(filePath));
  }
};
