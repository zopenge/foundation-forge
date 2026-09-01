import { availableParallelism } from 'node:os';

import type { TextIntegrityScanOptions } from './contracts.js';

const defaultIgnoredDirectoryNames = [
  '.cache',
  '.git',
  '.next',
  '.tmp',
  '.turbo',
  '.vite',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'output',
  'tmp',
] as const;
const defaultTextExtensions = [
  '.c',
  '.cc',
  '.cmake',
  '.cpp',
  '.css',
  '.h',
  '.hpp',
  '.html',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.mm',
  '.mts',
  '.ts',
  '.tsx',
  '.txt',
  '.wgsl',
  '.xml',
  '.yml',
  '.yaml',
] as const;
const defaultTextFileNames = ['AGENTS.md', 'CMakeLists.txt', 'LICENSE'] as const;

export interface TextIntegrityScanConfiguration {
  readonly concurrency: number;
  readonly ignoredDirectoryNames: ReadonlySet<string>;
  readonly ignoredPathPrefixes: readonly string[];
  readonly respectGitIgnore: boolean;
  readonly textExtensions: ReadonlySet<string>;
  readonly textFileNames: ReadonlySet<string>;
}

export const createScanConfiguration = (
  options: TextIntegrityScanOptions,
): TextIntegrityScanConfiguration => {
  const concurrency = options.concurrency
    ?? Math.max(4, Math.min(16, availableParallelism() * 2));
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    throw new Error('TEXT_INTEGRITY_INVALID_CONCURRENCY');
  }

  return {
    concurrency,
    ignoredDirectoryNames: new Set([
      ...defaultIgnoredDirectoryNames,
      ...(options.ignoredDirectoryNames ?? []),
    ]),
    ignoredPathPrefixes: (options.ignoredPathPrefixes ?? [])
      .map(normalizePathPrefix)
      .filter((prefix) => prefix.length > 0),
    respectGitIgnore: options.respectGitIgnore ?? true,
    textExtensions: new Set([
      ...defaultTextExtensions,
      ...(options.additionalTextExtensions ?? []),
    ]),
    textFileNames: new Set([
      ...defaultTextFileNames,
      ...(options.additionalTextFileNames ?? []),
    ]),
  };
};

const normalizePathPrefix = (prefix: string): string => prefix
  .replaceAll('\\', '/')
  .replace(/^\.\//u, '')
  .replace(/\/+$/u, '');
