import type { NavigationResult } from './contracts.js';

const byteLength = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;

export const fitResponse = (result: NavigationResult, maxBytes: number): NavigationResult => {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    maxBytes = 1;
  }
  if (byteLength(result) <= maxBytes) return result;
  const base = {
    schemaVersion: 1 as const,
    status: 'error' as const,
    corpusId: result.corpusId,
    generationId: result.generationId,
    corpusState: result.corpusState,
    coverage: result.coverage,
    truncated: false,
    nextCursor: null,
    diagnostics: [{ code: 'BUDGET_TOO_SMALL', details: { maxBytes, requiredBytes: byteLength(result) } }],
  };
  return 'entities' in result ? { ...base, entities: [] } : { ...base, edges: [] };
};
