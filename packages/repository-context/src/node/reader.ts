import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { readPublishedSourceSnapshotText } from '@openge/forge-source-snapshot/node';
import type { Diagnostic, SourceRef } from '../core/contracts.js';
import type { ReadRangesResult } from '../investigation/contracts.js';
import { discoverSourceSnapshot } from './discovery.js';
import { discoverSemanticInputs, repositoryInputDigest } from './semantic-inputs.js';
import type { StoredRepositoryGeneration } from './contracts.js';

export interface FileReader {
  readonly kind: 'current';
  readonly rootDir: string;
  readonly corpusId: string;
  readonly generationId: string;
}

export interface FrozenSnapshotSource {
  readonly targetRoot: string;
  readonly ownerId: string;
  readonly snapshotId: string;
}

interface FrozenVerifiedSource {
  readonly text: string;
  readonly sourceSha256: string;
}

export interface FrozenFileReader {
  readonly kind: 'frozen';
  readonly corpusId: string;
  readonly generationId: string;
  readonly snapshotId: string;
  readonly sources: ReadonlyMap<string, FrozenVerifiedSource>;
}

export type RepositoryFileReader = FileReader | FrozenFileReader;

export const createFileReader = (reader: Omit<FileReader, 'kind'>): FileReader => ({ kind: 'current', ...reader });
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

export const readRanges = async (reader: RepositoryFileReader, ranges: readonly SourceRef[]): Promise<ReadRangesResult> => {
  const texts = [];
  for (const source of ranges) {
    if (source.corpusId !== reader.corpusId || source.generationId !== reader.generationId) {
      throw Object.assign(new Error('source binding mismatch'), { code: 'SOURCE_CHANGED' });
    }
    let text: string;
    if (reader.kind === 'frozen') {
      const verified = reader.sources.get(source.path);
      if (!verified || verified.sourceSha256 !== source.sourceSha256) {
        throw Object.assign(new Error('frozen source binding mismatch'), { code: 'SOURCE_CHANGED' });
      }
      text = verified.text;
    } else {
      const bytes = await readFile(await safePath(reader.rootDir, source.path));
      if (sha256(bytes) !== source.sourceSha256) {
        throw Object.assign(new Error('source changed'), { code: 'SOURCE_CHANGED' });
      }
      text = bytes.toString('utf8');
    }
    const lines = text.split(/\r\n|\r|\n/u);
    if (source.lineStart < 1 || source.lineEnd < source.lineStart || source.lineEnd > lines.length) {
      throw Object.assign(new Error('invalid source range'), {
        code: 'INVALID_ARGUMENT',
        details: {
          path: source.path,
          lineStart: source.lineStart,
          lineEnd: source.lineEnd,
          availableLineEnd: lines.length,
        },
      });
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

export const verifyGenerationFrozen = async ({
  generation,
  source,
}: Readonly<{
  generation: StoredRepositoryGeneration;
  source: FrozenSnapshotSource;
}>): Promise<
  | Readonly<{
    status: 'ok';
    corpusState: 'frozen';
    snapshotId: string;
    diagnostics: readonly Diagnostic[];
    reader: FrozenFileReader;
  }>
  | Readonly<{
    status: 'error';
    corpusState: 'unknown';
    snapshotId: null;
    diagnostics: readonly Diagnostic[];
    reader: null;
  }>
> => {
  const missing = generation.semanticInputs.filter((item) => item.state === 'missing');
  if (missing.length > 0) {
    return {
      status: 'error',
      corpusState: 'unknown',
      snapshotId: null,
      diagnostics: [{ code: 'FROZEN_SOURCE_UNVERIFIED', details: { reason: 'missing-input-proof-unavailable', count: missing.length } }],
      reader: null,
    };
  }
  const expected = new Map<string, string>();
  for (const file of generation.files) expected.set(file.path, file.sourceSha256);
  for (const item of generation.semanticInputs) {
    if (item.sha256 === null) continue;
    const prior = expected.get(item.path);
    if (prior !== undefined && prior !== item.sha256) {
      return {
        status: 'error',
        corpusState: 'unknown',
        snapshotId: null,
        diagnostics: [{ code: 'FROZEN_SOURCE_UNVERIFIED', details: { reason: 'conflicting-source-digest' } }],
        reader: null,
      };
    }
    expected.set(item.path, item.sha256);
  }
  const sourcePaths = new Set(generation.files.map((file) => file.path));
  const verifiedSources = new Map<string, FrozenVerifiedSource>();
  try {
    for (const [path, expectedSha256] of [...expected.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const result = await readPublishedSourceSnapshotText({
        targetRoot: source.targetRoot,
        ownerId: source.ownerId,
        snapshotId: source.snapshotId,
        path,
      });
      if (result.snapshotId !== source.snapshotId || result.sourceSha256 !== expectedSha256) {
        return {
          status: 'error',
          corpusState: 'unknown',
          snapshotId: null,
          diagnostics: [{ code: 'FROZEN_SOURCE_UNVERIFIED', details: { reason: 'source-digest-mismatch' } }],
          reader: null,
        };
      }
      if (sourcePaths.has(path)) verifiedSources.set(path, { text: result.text, sourceSha256: result.sourceSha256 });
    }
  } catch (error) {
    const causeCode = (error as { readonly code?: unknown }).code;
    return {
      status: 'error',
      corpusState: 'unknown',
      snapshotId: null,
      diagnostics: [{
        code: 'FROZEN_SOURCE_UNVERIFIED',
        details: { causeCode: typeof causeCode === 'string' ? causeCode : 'UNKNOWN' },
      }],
      reader: null,
    };
  }
  return {
    status: 'ok',
    corpusState: 'frozen',
    snapshotId: source.snapshotId,
    diagnostics: [],
    reader: {
      kind: 'frozen',
      corpusId: generation.corpusId,
      generationId: generation.generationId,
      snapshotId: source.snapshotId,
      sources: verifiedSources,
    },
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
  let semanticCurrent;
  try {
    semanticCurrent = await discoverSemanticInputs({
      rootDir,
      sourceFiles: current.files,
      ...(generation.semanticConfigPath === null ? {} : { tsconfigPath: resolve(rootDir, generation.semanticConfigPath) }),
    });
  } catch (error) {
    const causeCode = (error as { readonly code?: unknown }).code;
    return {
      corpusState: 'stale',
      diagnostics: [{ code: 'SEMANTIC_INPUT_CHANGED', details: { causeCode: typeof causeCode === 'string' ? causeCode : 'UNKNOWN' } }],
    };
  }
  if (repositoryInputDigest(current.digest, semanticCurrent.digest) === generation.inputDigest) {
    return { corpusState: 'current-verified', diagnostics: [] };
  }

  const diagnostics: Diagnostic[] = [];
  const expectedFiles = new Map(generation.files.map((file) => [file.path, file]));
  const actualFiles = new Map(current.files.map((file) => [file.path, file]));
  const changedPaths = [...new Set([...expectedFiles.keys(), ...actualFiles.keys()])].filter((path) => (
    expectedFiles.get(path)?.sourceSha256 !== actualFiles.get(path)?.sourceSha256
  ));
  if (changedPaths.length > 0) diagnostics.push({ code: 'SOURCE_CHANGED', details: { changedPaths } });

  const semanticKey = (item: StoredRepositoryGeneration['semanticInputs'][number]): string => `${item.kind}|${item.path}`;
  const expectedSemantic = new Map(generation.semanticInputs.map((item) => [semanticKey(item), item]));
  const actualSemantic = new Map(semanticCurrent.inputs.map((item) => [semanticKey(item), item]));
  const changedSemanticInputs = [...new Set([...expectedSemantic.keys(), ...actualSemantic.keys()])].filter((key) => {
    const expected = expectedSemantic.get(key);
    const actual = actualSemantic.get(key);
    return expected?.state !== actual?.state || expected?.sha256 !== actual?.sha256
      || expected?.resolvedPath !== actual?.resolvedPath;
  });
  if (changedSemanticInputs.length > 0 || generation.configurationDigest !== semanticCurrent.configurationDigest) {
    diagnostics.push({
      code: 'SEMANTIC_INPUT_CHANGED',
      details: {
        changedInputs: changedSemanticInputs,
        configurationChanged: generation.configurationDigest !== semanticCurrent.configurationDigest,
      },
    });
  }
  if (diagnostics.length === 0) diagnostics.push({ code: 'SEMANTIC_INPUT_CHANGED', details: {} });
  return { corpusState: 'stale', diagnostics };
};
