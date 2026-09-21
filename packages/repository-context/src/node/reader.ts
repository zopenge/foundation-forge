import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { Diagnostic, SourceRef } from '../core/contracts.js';
import type { ReadRangesResult } from '../investigation/contracts.js';
import { discoverSourceSnapshot } from './discovery.js';
import type { StoredRepositoryGeneration } from './contracts.js';

export interface FileReader {
  readonly rootDir: string;
  readonly corpusId: string;
  readonly generationId: string;
}

export const createFileReader = (reader: FileReader): FileReader => ({ ...reader });
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const safePath = async (rootDir: string, path: string): Promise<string> => {
  if (!path || path.startsWith('/') || /^[A-Za-z]:[/\\]/u.test(path) || path.split(/[\\/]/u).includes('..')) {
    throw Object.assign(new Error('unsafe path'), { code: 'UNSAFE_PATH' });
  }
  const root = await realpath(resolve(rootDir));
  const candidate = await realpath(resolve(rootDir, path));
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw Object.assign(new Error('unsafe path'), { code: 'UNSAFE_PATH' });
  }
  return candidate;
};

export const readRanges = async (reader: FileReader, ranges: readonly SourceRef[]): Promise<ReadRangesResult> => {
  const texts = [];
  for (const source of ranges) {
    if (source.corpusId !== reader.corpusId || source.generationId !== reader.generationId) {
      throw Object.assign(new Error('source binding mismatch'), { code: 'SOURCE_CHANGED' });
    }
    const bytes = await readFile(await safePath(reader.rootDir, source.path));
    if (sha256(bytes) !== source.sourceSha256) {
      throw Object.assign(new Error('source changed'), { code: 'SOURCE_CHANGED' });
    }
    const lines = bytes.toString('utf8').split(/\r\n|\r|\n/u);
    if (source.lineStart < 1 || source.lineEnd < source.lineStart || source.lineEnd > lines.length) {
      throw Object.assign(new Error('invalid source range'), { code: 'INVALID_ARGUMENT' });
    }
    texts.push({
      source,
      path: source.path,
      lineStart: source.lineStart,
      lineEnd: source.lineEnd,
      text: lines.slice(source.lineStart - 1, source.lineEnd).join('\n'),
    });
  }
  return {
    schemaVersion: 1,
    status: 'ok',
    corpusId: reader.corpusId,
    generationId: reader.generationId,
    diagnostics: [],
    texts,
  };
};

export const verifyGenerationCurrent = async ({
  rootDir,
  generation,
}: Readonly<{ rootDir: string; generation: StoredRepositoryGeneration }>): Promise<{
  readonly corpusState: 'current-verified' | 'stale';
  readonly diagnostics: readonly Diagnostic[];
}> => {
  const current = await discoverSourceSnapshot(rootDir, generation.scopes, generation.languages);
  if (current.digest === generation.inputDigest) return { corpusState: 'current-verified', diagnostics: [] };
  const expected = new Map(generation.files.map((file) => [file.path, file]));
  const actual = new Map(current.files.map((file) => [file.path, file]));
  const changed = [...new Set([...expected.keys(), ...actual.keys()])].filter((path) => (
    expected.get(path)?.sourceSha256 !== actual.get(path)?.sourceSha256
  ));
  return {
    corpusState: 'stale',
    diagnostics: [{ code: 'SOURCE_CHANGED', details: { changedPaths: changed } }],
  };
};
