import { expect, test } from 'vitest';
import { createRepositoryInvestigator } from '../src/investigation/investigator.js';
import type { SourceRef } from '../src/core/contracts.js';
import { corpusFixture } from './repository-fixtures.js';

test('reuses a verified full-file hint read for candidate evidence within one query', async () => {
  const corpus = corpusFixture();
  const requested: SourceRef[] = [];
  const text = [
    'export function createSession(): void {',
    '  decodeSession();',
    '}',
    'export function helper(): void {}',
    'export const marker = true;',
    '',
  ].join('\n');
  const investigator = createRepositoryInvestigator({
    corpus, route: 'investigate', preferredScopes: ['src/'],
    readRanges: async (ranges) => {
      requested.push(...ranges);
      return { schemaVersion: 1, status: 'ok', corpusId: 'fixture', generationId: 'g1', diagnostics: [],
        texts: ranges.map((source) => ({ source, path: source.path, lineStart: source.lineStart, lineEnd: source.lineEnd,
          text: text.split('\n').slice(source.lineStart - 1, source.lineEnd).join('\n') })) };
    },
  });
  const result = await investigator.investigate({ query: 'createSession decodeSession' });
  expect(result.status).toBe('ok');
  expect(result.evidence.length).toBeGreaterThan(0);
  const sessionReads = requested.filter((source) => source.path === 'src/session.ts');
  expect(sessionReads).toHaveLength(1);
  expect(sessionReads[0]).toMatchObject({ lineStart: 1, lineEnd: 6 });
});
test('does not reuse verified body reads across separate investigate calls', async () => {
  const corpus = corpusFixture();
  let readCalls = 0;
  const investigator = createRepositoryInvestigator({
    corpus, route: 'investigate', preferredScopes: ['src/'],
    readRanges: async (ranges) => {
      readCalls += 1;
      return { schemaVersion: 1, status: 'ok', corpusId: 'fixture', generationId: 'g1', diagnostics: [],
        texts: ranges.map((source) => ({ source, path: source.path, lineStart: source.lineStart, lineEnd: source.lineEnd,
          text: Array.from({ length: source.lineEnd - source.lineStart + 1 }, (_, index) => `line ${source.lineStart + index} decodeSession`).join('\n') })) };
    },
  });
  await investigator.investigate({ query: 'decodeSession' });
  const afterFirst = readCalls;
  await investigator.investigate({ query: 'decodeSession' });
  expect(afterFirst).toBeGreaterThan(0);
  expect(readCalls).toBe(afterFirst * 2);
});