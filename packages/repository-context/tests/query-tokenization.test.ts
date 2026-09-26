import { expect, test } from 'vitest';
import { rankBm25Documents } from '../src/core/bm25.js';
import { searchEntities } from '../src/core/search.js';
import { tokenize } from '../src/core/tokenize.js';
import { queryFileNames, queryPathScopes, queryTokens } from '../src/investigation/query.js';
import { bestSymbolMatch } from '../src/investigation/ranking.js';
import { corpusFixture, sourceRef } from './repository-fixtures.js';

test('tokenizes camelCase acronyms separators unicode and short identifiers deterministically', () => {
  expect(tokenize('createHTTPServer')).toEqual(expect.arrayContaining(['create', 'http', 'server']));
  expect(tokenize('ERR_TIMEOUT_42')).toEqual(expect.arrayContaining(['err', 'timeout', '42']));
  expect(tokenize('x-id')).toEqual(expect.arrayContaining(['x', 'id']));
  expect(tokenize('ＩＤ')).toContain('id');
  expect(tokenize('查找超时重试')).toEqual(expect.arrayContaining(['查找超时重试', '超时', '重试']));
  expect(queryTokens('id 超时重试')).toEqual(expect.arrayContaining(['id', '超时', '重试']));
});

test('extracts the exact child scope used by the run014 smoke-07 query', () => {
  expect(queryPathScopes('packages/ai-forge-core/src/infra/worker-pool export class interface type',
    new Set(['packages']))).toEqual([
    'packages/ai-forge-core/src/infra/worker-pool',
  ]);
});

test('已解码的 Windows 路径与正斜杠路径定位相同，危险与绝对路径不被提升', () => {
  const slash = String.fromCharCode(92);
  const roots = new Set(['src']);
  expect(queryPathScopes(`find src${slash}a.ts`, roots)).toEqual(['src/a.ts']);
  expect(queryPathScopes(`find src${slash}${slash}a.ts`, roots)).toEqual(['src/a.ts']);
  expect(queryPathScopes(`find C:${slash}src${slash}a.ts`, roots)).toEqual([]);
  expect(queryPathScopes(`find ${slash}${slash}server${slash}share${slash}a.ts`, roots)).toEqual([]);
  expect(queryPathScopes('find https://example.test/src/a.ts', roots)).toEqual([]);
  expect(queryPathScopes(`find src${slash}..${slash}a.ts`, roots)).toEqual([]);
  expect(queryPathScopes('find validates/rejects', roots)).toEqual([]);
  expect(queryFileNames('find a.ts')).toEqual(['a.ts']);
  expect(queryFileNames(`find src${slash}a.ts`)).toEqual([]);
});

test('keeps an exact short symbol ahead of broader lexical matches', () => {
  const base = corpusFixture();
  const corpus = {
    ...base,
    entities: [
      ...base.entities,
      {
        id: 'symbol:id', kind: 'symbol' as const, name: 'id', owner: null, signature: 'const id: string',
        source: sourceRef('src/id.ts'), evidenceLevel: 'syntax' as const,
      },
      {
        id: 'symbol:identity', kind: 'symbol' as const, name: 'identity', owner: null, signature: 'const identity: string',
        source: sourceRef('src/identity.ts'), evidenceLevel: 'syntax' as const,
      },
    ],
  };
  const result = searchEntities(corpus, { by: 'text', value: 'id', limit: 5 });
  expect(result.entities[0]?.id).toBe('symbol:id');
});

test('instruction verbs do not outweigh the workspace graph operation in a diagnostic query', () => {
  const source = sourceRef('packages/workspace-graph/src/graph.ts');
  const symbols = [
    { id: 'symbol:find', kind: 'symbol' as const, name: 'findWorkspaceCycles', owner: null,
      signature: 'export function findWorkspaceCycles(): WorkspaceGraphCycle[]', source,
      evidenceLevel: 'syntax' as const },
    { id: 'symbol:create', kind: 'symbol' as const, name: 'createWorkspaceGraph', owner: null,
      signature: 'export function createWorkspaceGraph(): WorkspaceGraph', source,
      evidenceLevel: 'syntax' as const },
  ];
  const query = 'Locate workspace graph diagnostics. Find regression causing unresolved workspace dependencies; identify source to edit.';

  expect(queryTokens('findWorkspaceCycles')).toContain('find');
  expect(bestSymbolMatch(symbols, source.path, queryTokens(query))?.entity.id).toBe('symbol:create');
});
test('BM25 ranking matches an independently calculated fixture', () => {
  const documents = [
    { id: 'a', tokens: ['timeout', 'retry'] },
    { id: 'b', tokens: ['timeout'] },
    { id: 'c', tokens: ['retry', 'retry', 'retry'] },
  ];
  const query = ['timeout', 'retry'];
  const k1 = 1.2;
  const b = 0.75;
  const averageLength = documents.reduce((sum, document) => sum + document.tokens.length, 0) / documents.length;
  const score = (document: (typeof documents)[number]) => query.reduce((total, token) => {
    const df = documents.filter((candidate) => candidate.tokens.includes(token)).length;
    const tf = document.tokens.filter((value) => value === token).length;
    if (tf === 0) return total;
    const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
    const denominator = tf + k1 * (1 - b + b * document.tokens.length / averageLength);
    return total + idf * (tf * (k1 + 1) / denominator);
  }, 0);
  const expected = [...documents].sort((left, right) => score(right) - score(left) || left.id.localeCompare(right.id)).map((item) => item.id);
  const actual = rankBm25Documents(documents, query, { k1, b }).map((item) => item.id);
  expect(actual).toEqual(expected);
});
