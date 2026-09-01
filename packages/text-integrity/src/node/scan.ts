import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import { inspectTextIntegrity } from '../inspection.js';
import type { TextIntegrityIssue, TextIntegrityIssueCode } from '../contracts.js';
import { createScanConfiguration } from './configuration.js';
import type { TextIntegrityScanOptions } from './contracts.js';
import { collectChangedTextFiles, filterGitRelevantFiles } from './git.js';
import {
  collectTextFiles,
  compareNormalizedPaths,
  normalizeRepoPath,
} from './paths.js';

const issueCodeOrder: Readonly<Record<TextIntegrityIssueCode, number>> = {
  'question-placeholder': 0,
  'replacement-character': 1,
  'private-use-character': 2,
  'mojibake-token-cluster': 3,
  'latin1-mojibake-cluster': 4,
};

export const scanTextIntegrityPaths = async (
  paths: readonly string[],
  options: TextIntegrityScanOptions = {},
): Promise<readonly TextIntegrityIssue[]> => {
  const cwd = resolve(options.cwd ?? process.cwd());
  const configuration = createScanConfiguration(options);
  const collectedFiles = await collectTextFiles(paths, cwd, configuration);
  const files = configuration.respectGitIgnore
    ? await filterGitRelevantFiles(collectedFiles)
    : collectedFiles;

  return scanFiles(files, cwd, options, configuration.concurrency);
};

export const scanChangedTextIntegrityFiles = async (
  options: TextIntegrityScanOptions = {},
): Promise<readonly TextIntegrityIssue[]> => {
  const cwd = resolve(options.cwd ?? process.cwd());
  const configuration = createScanConfiguration(options);
  const files = await collectChangedTextFiles(cwd, configuration);

  return scanFiles(files, cwd, options, configuration.concurrency);
};

const scanFiles = async (
  files: readonly string[],
  cwd: string,
  options: TextIntegrityScanOptions,
  concurrency: number,
): Promise<readonly TextIntegrityIssue[]> => {
  const fileResults = await mapWithConcurrency(files, concurrency, async (file) => {
    const contents = await readFile(file);
    if (contents.includes(0)) {
      return [];
    }
    return inspectTextIntegrity(contents.toString('utf8'), {
      filePath: normalizeRepoPath(relative(cwd, file)),
      ...(options.ignoreLineMarker === undefined
        ? {}
        : { ignoreLineMarker: options.ignoreLineMarker }),
      ...(options.ignoreMarkdownCodeSpans === undefined
        ? {}
        : { ignoreMarkdownCodeSpans: options.ignoreMarkdownCodeSpans }),
    });
  });

  return fileResults.flat().sort(compareIssues);
};

const compareIssues = (left: TextIntegrityIssue, right: TextIntegrityIssue): number => (
  compareNormalizedPaths(left.file, right.file)
  || left.line - right.line
  || issueCodeOrder[left.code] - issueCodeOrder[right.code]
);

const mapWithConcurrency = async <Input, Output>(
  items: readonly Input[],
  concurrency: number,
  mapper: (item: Input) => Promise<Output>,
): Promise<readonly Output[]> => {
  const results = new Array<Output>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const item = items[currentIndex];
      if (item !== undefined) {
        results[currentIndex] = await mapper(item);
      }
    }
  });

  await Promise.all(workers);
  return results;
};
