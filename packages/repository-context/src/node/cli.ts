#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRepositoryInvestigator } from '../investigation/investigator.js';
import type { InvestigationView, ReadRangeRequest } from '../presentation/contracts.js';
import { serializeInvestigationPage, serializeReadPage } from '../presentation/page.js';
import { serializeBuildSummary, serializeCheckSummary, serializeCliError } from '../presentation/response.js';
import { buildRepositoryCorpus } from './build.js';
import type { RepositoryLanguage } from './contracts.js';
import { createFileReader, readRanges, verifyGenerationCurrent, verifyGenerationFrozen, type RepositoryFileReader } from './reader.js';
import { loadCurrentGeneration } from './store.js';

export interface RepositoryContextCliIo {
  write(value: string): void;
}

export const isRepositoryContextCliEntry = (
  entry: string | undefined,
  moduleUrl: string,
  realpath: (value: string) => string = realpathSync,
): boolean => {
  if (entry === undefined) return false;
  try {
    return realpath(entry) === realpath(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
};

const parse = (args: readonly string[]): { readonly command: string; readonly values: ReadonlyMap<string, readonly string[]> } => {
  const [command = '', ...rest] = args;
  const values = new Map<string, string[]>();
  const allowed = new Set([
    '--root', '--index', '--corpus', '--scope', '--language', '--tsconfig', '--query', '--view', '--max-bytes', '--cursor',
    '--path', '--line-start', '--line-end', '--ranges-json', '--snapshot-root', '--snapshot-owner', '--snapshot-id',
  ]);
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index] ?? '';
    const value = rest[index + 1];
    if (!allowed.has(flag) || value === undefined || value.startsWith('--')) {
      throw Object.assign(new Error('invalid command argument'), { code: 'INVALID_ARGUMENT', details: { flag } });
    }
    values.set(flag, [...(values.get(flag) ?? []), value]);
  }
  return { command, values };
};

const one = (values: ReadonlyMap<string, readonly string[]>, name: string, required = true): string | undefined => {
  const found = values.get(name);
  if (found && found.length === 1) return found[0];
  if (!required && found === undefined) return undefined;
  throw Object.assign(new Error('invalid command argument'), { code: 'INVALID_ARGUMENT', details: { field: name } });
};

const many = (values: ReadonlyMap<string, readonly string[]>, name: string): readonly string[] => values.get(name) ?? [];

const commandFlags: Readonly<Record<string, ReadonlySet<string>>> = {
  build: new Set(['--root', '--index', '--corpus', '--scope', '--language', '--tsconfig']),
  check: new Set(['--root', '--index', '--snapshot-root', '--snapshot-owner', '--snapshot-id']),
  investigate: new Set(['--root', '--index', '--query', '--scope', '--view', '--max-bytes', '--cursor', '--snapshot-root', '--snapshot-owner', '--snapshot-id']),
  read: new Set(['--root', '--index', '--path', '--line-start', '--line-end', '--ranges-json', '--max-bytes', '--cursor', '--snapshot-root', '--snapshot-owner', '--snapshot-id']),
};

const validateCommandFlags = (command: string, values: ReadonlyMap<string, readonly string[]>): void => {
  const allowed = commandFlags[command];
  if (!allowed) throw Object.assign(new Error('unknown command'), { code: 'INVALID_ARGUMENT', details: { field: 'command' } });
  for (const flag of values.keys()) {
    if (!allowed.has(flag)) throw Object.assign(new Error('invalid command argument'), {
      code: 'INVALID_ARGUMENT', details: { field: flag },
    });
  }
};

const integer = (value: string | undefined, field: string, fallback: number, min: number, max: number): number => {
  if (value === undefined) return fallback;
  if (!/^[0-9]+$/u.test(value)) throw Object.assign(new Error('invalid command argument'), { code: 'INVALID_ARGUMENT', details: { field } });
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw Object.assign(new Error('invalid command argument'), { code: 'INVALID_ARGUMENT', details: { field } });
  }
  return parsed;
};

const parseView = (value: string | undefined): InvestigationView => {
  if (value === undefined) return 'evidence';
  if (value === 'locate' || value === 'evidence' || value === 'relations') return value;
  throw Object.assign(new Error('invalid command argument'), { code: 'INVALID_ARGUMENT', details: { field: '--view' } });
};

const parseReadRequests = (values: ReadonlyMap<string, readonly string[]>): readonly ReadRangeRequest[] => {
  const rangesJson = one(values, '--ranges-json', false);
  const path = one(values, '--path', false);
  const lineStart = one(values, '--line-start', false);
  const lineEnd = one(values, '--line-end', false);
  if (rangesJson !== undefined) {
    if (path !== undefined || lineStart !== undefined || lineEnd !== undefined || Buffer.byteLength(rangesJson, 'utf8') > 32 * 1024) {
      throw Object.assign(new Error('invalid command argument'), { code: 'INVALID_ARGUMENT', details: { field: '--ranges-json' } });
    }
    let parsed: unknown;
    try { parsed = JSON.parse(rangesJson); } catch { throw Object.assign(new Error('invalid command argument'), { code: 'INVALID_ARGUMENT', details: { field: '--ranges-json' } }); }
    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 16) {
      throw Object.assign(new Error('invalid command argument'), { code: 'INVALID_ARGUMENT', details: { field: '--ranges-json' } });
    }
    return parsed.map((item) => {
      if (!item || typeof item !== 'object') throw Object.assign(new Error('invalid command argument'), { code: 'INVALID_ARGUMENT', details: { field: '--ranges-json' } });
      const value = item as Partial<ReadRangeRequest> & Readonly<Record<string, unknown>>;
      if (Object.keys(value).some((key) => !['path', 'lineStart', 'lineEnd'].includes(key)) || typeof value.path !== 'string'
        || !Number.isSafeInteger(value.lineStart) || !Number.isSafeInteger(value.lineEnd) || (value.lineStart ?? 0) < 1
        || (value.lineEnd ?? 0) < (value.lineStart ?? 0)) {
        throw Object.assign(new Error('invalid command argument'), { code: 'INVALID_ARGUMENT', details: { field: '--ranges-json' } });
      }
      return { path: value.path, lineStart: value.lineStart as number, lineEnd: value.lineEnd as number };
    });
  }
  if (path === undefined || lineStart === undefined || lineEnd === undefined) {
    throw Object.assign(new Error('invalid command argument'), { code: 'INVALID_ARGUMENT', details: { field: '--path' } });
  }
  const start = integer(lineStart, '--line-start', 0, 1, Number.MAX_SAFE_INTEGER);
  const end = integer(lineEnd, '--line-end', 0, 1, Number.MAX_SAFE_INTEGER);
  if (end < start) throw Object.assign(new Error('invalid command argument'), { code: 'INVALID_ARGUMENT', details: { field: '--line-end' } });
  return [{ path, lineStart: start, lineEnd: end }];
};

export const runRepositoryContextCli = async (
  args: readonly string[],
  io: RepositoryContextCliIo = { write: (value) => process.stdout.write(`${value}\n`) },
): Promise<number> => {
  try {
    const parsed = parse(args);
    validateCommandFlags(parsed.command, parsed.values);
    const rootDir = one(parsed.values, '--root');
    const indexRoot = one(parsed.values, '--index');
    if (!rootDir || !indexRoot) throw Object.assign(new Error('missing path'), { code: 'INVALID_ARGUMENT' });
    if (parsed.command === 'build') {
      const corpusId = one(parsed.values, '--corpus');
      const scopes = many(parsed.values, '--scope');
      const languages = many(parsed.values, '--language');
      if (!corpusId || scopes.length === 0 || languages.some((value) => value !== 'typescript' && value !== 'cpp')) {
        throw Object.assign(new Error('invalid build arguments'), { code: 'INVALID_ARGUMENT' });
      }
      const tsconfigPath = one(parsed.values, '--tsconfig', false);
      const result = await buildRepositoryCorpus({
        rootDir,
        indexRoot,
        corpusId,
        scopes,
        languages: languages as readonly RepositoryLanguage[],
        ...(tsconfigPath === undefined ? {} : { tsconfigPath }),
      });
      io.write(serializeBuildSummary(result));
      return result.status === 'ok' ? 0 : 1;
    }
    const query = parsed.command === 'investigate' ? (one(parsed.values, '--query') ?? '') : '';
    const scopes = parsed.command === 'investigate' ? many(parsed.values, '--scope') : [];
    const view = parsed.command === 'investigate' ? parseView(one(parsed.values, '--view', false)) : 'evidence';
    const maxBytes = parsed.command === 'investigate'
      ? integer(one(parsed.values, '--max-bytes', false), '--max-bytes', 4096, 1024, 262144)
      : parsed.command === 'read'
        ? integer(one(parsed.values, '--max-bytes', false), '--max-bytes', 16384, 1024, 262144)
        : 2048;
    const cursor = parsed.command === 'investigate' || parsed.command === 'read' ? (one(parsed.values, '--cursor', false) ?? null) : null;
    if (parsed.command === 'investigate' && (!query || query.length > 8192 || scopes.length > 16 || scopes.some((scope) => scope.length > 4096))) {
      throw Object.assign(new Error('invalid investigation request'), { code: 'INVALID_ARGUMENT', details: { field: '--query' } });
    }
    const requestedRanges = parsed.command === 'read' ? parseReadRequests(parsed.values) : [];
    const snapshotRoot = parsed.command === 'build' ? undefined : one(parsed.values, '--snapshot-root', false);
    const snapshotOwner = parsed.command === 'build' ? undefined : one(parsed.values, '--snapshot-owner', false);
    const snapshotId = parsed.command === 'build' ? undefined : one(parsed.values, '--snapshot-id', false);
    const snapshotValues = [snapshotRoot, snapshotOwner, snapshotId].filter((value) => value !== undefined);
    if (snapshotValues.length !== 0 && snapshotValues.length !== 3) {
      throw Object.assign(new Error('incomplete frozen source arguments'), {
        code: 'INVALID_ARGUMENT', details: { field: '--snapshot-root' },
      });
    }
    const generation = await loadCurrentGeneration(indexRoot);
    let reader: RepositoryFileReader | null = null;
    const verification = snapshotRoot !== undefined && snapshotOwner !== undefined && snapshotId !== undefined
      ? await verifyGenerationFrozen({
        generation,
        source: { targetRoot: snapshotRoot, ownerId: snapshotOwner, snapshotId },
      })
      : await verifyGenerationCurrent({ rootDir, generation });
    if (verification.corpusState === 'frozen') reader = verification.reader;
    const effectiveGeneration = verification.corpusState === 'frozen'
      ? { ...generation, corpus: { ...generation.corpus, corpusState: 'frozen' as const } }
      : generation;
    if (parsed.command === 'check') {
      if (snapshotRoot !== undefined && verification.corpusState !== 'frozen') {
        io.write(serializeCliError('FROZEN_SOURCE_UNVERIFIED', { diagnostics: verification.diagnostics }, maxBytes));
        return 1;
      }
      io.write(serializeCheckSummary(effectiveGeneration, verification));
      return verification.corpusState === 'current-verified' || verification.corpusState === 'frozen' ? 0 : 1;
    }
    if (parsed.command === 'investigate') {
      if (verification.corpusState !== 'current-verified' && verification.corpusState !== 'frozen') {
        const code = snapshotRoot === undefined ? 'SOURCE_CHANGED' : 'FROZEN_SOURCE_UNVERIFIED';
        io.write(serializeCliError(code, { diagnostics: verification.diagnostics }, maxBytes));
        return 1;
      }
      const activeReader = reader ?? createFileReader({
        rootDir, corpusId: generation.corpusId, generationId: generation.generationId,
      });
      const useRelations = view === 'relations';
      const investigator = createRepositoryInvestigator({
        corpus: effectiveGeneration.corpus,
        readRanges: (ranges) => readRanges(activeReader, ranges),
        route: useRelations ? 'investigate-relations' : 'investigate',
        preferredScopes: scopes,
        promoteRelationEndpoints: useRelations,
        includeEvidence: view !== 'locate',
      });
      const result = await investigator.investigate({
        query,
        ...(view === 'evidence' ? { evidenceBudget: { maxBytes } } : {}),
        ...(scopes.length > 0 ? { scope: scopes } : {}),
      });
      const page = serializeInvestigationPage(result, effectiveGeneration, {
        corpusId: generation.corpusId,
        generationId: generation.generationId,
        query,
        scope: scopes,
        view,
        cursor,
        budget: { maxBytes, maxCandidates: 3, maxRelations: 8 },
      });
      io.write(page.stdout);
      return result.status === 'ok' || result.status === 'ambiguous' ? 0 : 1;
    }
    if (parsed.command === 'read') {
      if (verification.corpusState !== 'current-verified' && verification.corpusState !== 'frozen') {
        const code = snapshotRoot === undefined ? 'SOURCE_CHANGED' : 'FROZEN_SOURCE_UNVERIFIED';
        io.write(serializeCliError(code, { diagnostics: verification.diagnostics }, maxBytes));
        return 1;
      }
      const files = new Map(generation.files.map((file) => [file.path, file]));
      const refs = requestedRanges.map((range) => {
        const file = files.get(range.path);
        if (!file) throw Object.assign(new Error('invalid read path'), { code: 'INVALID_ARGUMENT', details: { field: 'path' } });
        return {
          corpusId: generation.corpusId, generationId: generation.generationId, path: range.path,
          sourceSha256: file.sourceSha256, normalizedSha256: null, snapshotId: null,
          lineStart: range.lineStart, lineEnd: range.lineEnd,
        };
      });
      const activeReader = reader ?? createFileReader({
        rootDir, corpusId: generation.corpusId, generationId: generation.generationId,
      });
      const read = await readRanges(activeReader, refs);
      const page = serializeReadPage(read.texts, effectiveGeneration, {
        corpusId: generation.corpusId, generationId: generation.generationId, ranges: requestedRanges, cursor,
        budget: { maxBytes, maxCandidates: 16, maxRelations: 0 },
      });
      io.write(page.stdout);
      return 0;
    }
    throw Object.assign(new Error('unknown command'), { code: 'INVALID_ARGUMENT', details: { command: parsed.command } });
  } catch (error) {
    const code = (error as { readonly code?: unknown }).code;
    const details = (error as { readonly details?: unknown }).details;
    io.write(serializeCliError(typeof code === 'string' ? code : 'INTERNAL_ERROR', details ?? {}));
    return 1;
  }
};

const entry = process.argv[1];
if (isRepositoryContextCliEntry(entry, import.meta.url)) {
  process.exitCode = await runRepositoryContextCli(process.argv.slice(2));
}
