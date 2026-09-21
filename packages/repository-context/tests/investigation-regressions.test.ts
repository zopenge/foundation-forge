import { expect, test } from 'vitest';
import { createRepositoryInvestigator } from '../src/index.js';
import type { Corpus, SourceRef } from '../src/core/contracts.js';
import { corpusFixture } from './repository-fixtures.js';

const reader = async (ranges: readonly SourceRef[]) => ({
  schemaVersion: 1 as const,
  status: 'ok' as const,
  corpusId: 'fixture',
  generationId: 'g1',
  diagnostics: [],
  texts: ranges.map((source) => ({
    source,
    path: source.path,
    lineStart: source.lineStart,
    lineEnd: source.lineEnd,
    text: `export function ${source.path.includes('decode') ? 'decodeSession' : 'createSession'}() { return true; }`,
  })),
});

test('promotes resolved relation endpoint paths without duplicating candidates', async () => {
  const investigator = createRepositoryInvestigator({
    corpus: corpusFixture(),
    readRanges: reader,
    route: 'investigate-relations',
    preferredScopes: ['src/'],
    promoteRelationEndpoints: true,
  });
  const result = await investigator.investigate({ query: 'createSession' });
  expect(result.relations.some((edge) => edge.toPath === 'src/decode.ts')).toBe(true);
  expect(new Set(result.candidates.map((item) => item.id)).size).toBe(result.candidates.length);
});

test('rejects a blank query with a structured result', async () => {
  const investigator = createRepositoryInvestigator({
    corpus: corpusFixture() as Corpus,
    readRanges: reader,
    route: 'investigate',
  });
  const result = await investigator.investigate({ query: '   ' });
  expect(result.status).toBe('error');
  expect(result.diagnostics[0]?.code).toBe('INVALID_ARGUMENT');
});

test('preserves evidence for an explicitly requested file scope without a lexical match', async () => {
  const corpus = corpusFixture();
  const fileOnlyCorpus: Corpus = {
    ...corpus,
    entities: [...corpus.entities, {
      id: 'file:empty',
      kind: 'file',
      name: 'empty.ts',
      owner: null,
      signature: null,
      source: {
        corpusId: 'fixture', generationId: 'g1', path: 'src/empty.ts', sourceSha256: 'a'.repeat(64),
        normalizedSha256: null, snapshotId: null, lineStart: 1, lineEnd: 1,
      },
      evidenceLevel: 'literal-path',
    }],
  };
  const investigator = createRepositoryInvestigator({
    corpus: fileOnlyCorpus,
    readRanges: reader,
    route: 'investigate-relations',
    preferredScopes: ['src/empty.ts'],
    limits: { maxCandidates: 5, sourceHintLines: 3 },
  });

  const result = await investigator.investigate({
    query: 'qqqzzzxxyy',
    scope: ['src/empty.ts'],
  });

  expect(result.status).toBe('ok');
  expect(result.sourceHints.map((item) => item.path)).toContain('src/empty.ts');
  expect(result.primaryScopeCoverage.missing).toEqual([]);
});
