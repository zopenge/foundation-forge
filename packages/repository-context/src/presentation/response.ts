import type { CorpusState, Diagnostic } from '../core/contracts.js';
import type { BuildRepositoryCorpusResult, StoredRepositoryGeneration } from '../node/contracts.js';

const SUMMARY_WIRE_MAX_BYTES = 2_048;
const MAX_DIAGNOSTICS = 6;
const MAX_DETAIL_KEYS = 6;
const MAX_ARRAY_ITEMS = 3;
const MAX_STRING_LENGTH = 160;

const byteLength = (value: string): number => Buffer.byteLength(value, 'utf8');
const compactString = (value: string): string => value.length <= MAX_STRING_LENGTH
  ? value
  : `${value.slice(0, MAX_STRING_LENGTH - 3)}...`;

const compactValue = (value: unknown, depth = 0): unknown => {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return compactString(value);
  if (Array.isArray(value)) {
    if (depth >= 2) return { count: value.length };
    return { count: value.length, preview: value.slice(0, MAX_ARRAY_ITEMS).map((item) => compactValue(item, depth + 1)) };
  }
  if (typeof value === 'object') {
    if (depth >= 2) return { type: 'object' };
    return Object.fromEntries(Object.entries(value as Readonly<Record<string, unknown>>)
      .slice(0, MAX_DETAIL_KEYS)
      .map(([key, item]) => [key, compactValue(item, depth + 1)]));
  }
  return { type: typeof value };
};
const compactDiagnostics = (diagnostics: readonly Diagnostic[]) => diagnostics.slice(0, MAX_DIAGNOSTICS).map((item) => ({
  code: compactString(item.code),
  details: compactValue(item.details),
}));

const serialize = (value: unknown, fallback: unknown, maxWireBytes = SUMMARY_WIRE_MAX_BYTES): string => {
  const serialized = JSON.stringify(value);
  if (byteLength(serialized) + 1 <= maxWireBytes) return serialized;
  return JSON.stringify(fallback);
};

const identity = (result: BuildRepositoryCorpusResult) => {
  const corpus = result.corpus ?? result.generation?.corpus ?? null;
  return {
    corpusId: compactString(result.generation?.corpusId ?? corpus?.corpusId ?? '') || null,
    generationId: compactString(result.generation?.generationId ?? corpus?.generationId ?? '') || null,
    corpusState: corpus?.corpusState ?? null,
  };
};

export const serializeBuildSummary = (result: BuildRepositoryCorpusResult): string => {
  const generation = result.generation;
  const corpus = result.corpus ?? generation?.corpus ?? null;
  const id = identity(result);
  const summary = {
    schemaVersion: 1,
    status: result.status,
    ...id,
    counts: {
      files: generation?.files.length ?? null,
      entities: corpus?.entities.length ?? null,
      relations: corpus?.edges.length ?? null,
      diagnostics: result.diagnostics.length,
    },
    diagnostics: compactDiagnostics(result.diagnostics),
  };
  return serialize(summary, {
    schemaVersion: 1, status: result.status, ...id,
    counts: { diagnostics: result.diagnostics.length },
    diagnostics: compactDiagnostics(result.diagnostics).map(({ code }) => ({ code })),
  });
};

interface CurrentVerification {
  readonly corpusState: CorpusState;
  readonly diagnostics: readonly Diagnostic[];
}

export const serializeCheckSummary = (
  generation: StoredRepositoryGeneration,
  verification: CurrentVerification,
): string => {
  const status = verification.corpusState === 'current-verified' || verification.corpusState === 'frozen'
    ? 'ok' : verification.corpusState === 'stale' ? 'stale' : 'error';
  const summary = {
    schemaVersion: 1,
    status,
    corpusId: compactString(generation.corpusId),
    generationId: compactString(generation.generationId),
    corpusState: verification.corpusState,
    counts: { diagnostics: verification.diagnostics.length },
    diagnostics: compactDiagnostics(verification.diagnostics),
  };
  return serialize(summary, {
    schemaVersion: 1, status, corpusId: compactString(generation.corpusId), generationId: compactString(generation.generationId),
    corpusState: verification.corpusState, counts: { diagnostics: verification.diagnostics.length },
    diagnostics: compactDiagnostics(verification.diagnostics).map(({ code }) => ({ code })),
  });
};

export const serializeCliError = (code: string, details: unknown, maxWireBytes = SUMMARY_WIRE_MAX_BYTES): string => {
  const diagnostics = [{ code: compactString(code), details: compactValue(details) }];
  return serialize({ schemaVersion: 1, status: 'error', diagnostics },
    { schemaVersion: 1, status: 'error', diagnostics: [{ code: compactString(code), details: {} }] }, maxWireBytes);
};