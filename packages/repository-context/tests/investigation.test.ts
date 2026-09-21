import { describe, expect, test, vi } from 'vitest';
import { createRepositoryInvestigator } from '../src/index.js';
import type { SourceRef } from '../src/core/contracts.js';
import { corpusFixture } from './repository-fixtures.js';

const sourceText = new Map<string, string>([
  ['src/session.ts', [
    'export function createSession() {',
    '  return decodeSession();',
    '}',
    'export function validateSession(input: string) {',
    "  if (input === 'invalid') throw new Error('session failure');",
    '}',
  ].join('\n')],
  ['src/decode.ts', [
    'export function decodeSession(input: string) {',
    '  if (input.length === 0) throw new Error("invalid session");',
    '  return input;',
    '}',
  ].join('\n')],
  ['src/network.ts', 'export function createSession() { return null; }'],
]);

const readRanges = vi.fn(async (ranges: readonly SourceRef[]) => ({
  schemaVersion: 1 as const,
  status: 'ok' as const,
  corpusId: 'fixture',
  generationId: 'g1',
  diagnostics: [],
  texts: ranges.map((source) => {
    const lines = (sourceText.get(source.path) ?? '').split('\n');
    return {
      source,
      path: source.path,
      lineStart: source.lineStart,
      lineEnd: Math.min(source.lineEnd, lines.length),
      text: lines.slice(source.lineStart - 1, source.lineEnd).join('\n'),
    };
  }),
}));

describe('repository investigation', () => {
  test('returns ranked candidates, evidence and preferred-scope coverage', async () => {
    const investigator = createRepositoryInvestigator({
      corpus: corpusFixture(),
      readRanges,
      route: 'investigate-relations',
      preferredScopes: ['src/'],
      limits: { maxCandidates: 3, evidenceLines: 24, sourceHintLines: 6 },
      promoteRelationEndpoints: true,
    });

    const result = await investigator.investigate({ query: 'decodeSession invalid failure' });

    expect(result.status).toBe('ok');
    expect(result.candidates[0]?.name).toBe('decodeSession');
    expect(result.evidence[0]?.path).toBe('src/decode.ts');
    expect(result.sourceHints.some((hint) => /throw/u.test(hint.text))).toBe(true);
    expect(result.primaryScopeCoverage.covered).toEqual(['src/']);
  });

  test('returns insufficient without inventing evidence or extra reads', async () => {
    readRanges.mockClear();
    const investigator = createRepositoryInvestigator({
      corpus: corpusFixture(),
      readRanges,
      route: 'investigate',
      preferredScopes: [],
    });

    const result = await investigator.investigate({ query: 'unrelated impossible phrase' });

    expect(result).toMatchObject({
      status: 'insufficient',
      reason: 'NO_USEFUL_CANDIDATE',
      candidates: [],
      evidence: [],
      sourceHints: [],
    });
    expect(readRanges).not.toHaveBeenCalled();
  });

  test('reads at most one direct evidence range per source file', async () => {
    const investigator = createRepositoryInvestigator({
      corpus: corpusFixture(),
      readRanges,
      route: 'investigate-relations',
      preferredScopes: ['src/'],
      limits: { maxCandidates: 5 },
    });

    const result = await investigator.investigate({ query: 'session' });
    const evidencePaths = result.evidence.map((item) => item.path);

    expect(evidencePaths.length).toBeGreaterThan(0);
    expect(new Set(evidencePaths).size).toBe(evidencePaths.length);
  });
});
