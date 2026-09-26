import { describe, expect, test } from 'vitest';
import { describeEntities, fitResponse, queryRelations, searchEntities } from '../src/index.js';
import { corpusFixture } from './repository-fixtures.js';

describe('repository context core navigation', () => {
  test('returns deterministic path and symbol matches with source bindings', () => {
    const corpus = corpusFixture();
    const symbols = searchEntities(corpus, { by: 'symbol', value: 'createSession', limit: 5 });
    expect(symbols.status).toBe('ambiguous');
    expect(symbols.entities.map((item) => item.id)).toEqual([
      'symbol:network:createSession',
      'symbol:session:createSession',
    ]);

    const paths = searchEntities(corpus, { by: 'path', value: 'src/session.ts', limit: 5 });
    expect(paths.status).toBe('ok');
    expect(paths.entities.map((item) => item.id)).toEqual(['file:session']);

    expect(describeEntities(corpus, ['symbol:session:createSession']).entities).toHaveLength(1);
  });

  test('walks relation edges within the requested depth', () => {
    const result = queryRelations(corpusFixture(), {
      ids: ['symbol:session:createSession'],
      direction: 'out',
      depth: 1,
    });
    expect(result.status).toBe('ok');
    expect(result.edges.map((item) => [item.from, item.to])).toEqual([
      ['symbol:session:createSession', 'symbol:session:decodeSession'],
    ]);
  });

  test('rejects a response budget that cannot preserve an exact result', () => {
    const result = searchEntities(corpusFixture(), { by: 'symbol', value: 'decodeSession', limit: 5 });
    const fitted = fitResponse(result, 8);
    expect(fitted.status).toBe('error');
    expect(fitted.diagnostics[0]?.code).toBe('BUDGET_TOO_SMALL');
  });

  test('treats scopes as path boundaries rather than raw string prefixes', () => {
    const base = corpusFixture();
    const first = base.entities[0];
    if (first === undefined) throw new Error('fixture must contain an entity');
    const corpus = {
      ...base,
      entities: [
        ...base.entities,
        {
          ...first,
          id: 'symbol:prefix-collision',
          source: { ...first.source, path: 'src/session.ts-extra' },
        },
      ],
    };
    const result = searchEntities(corpus, { by: 'text', value: 'createSession', scope: ['src/session.ts'], limit: 5 });
    expect(result.entities.map((item) => item.id)).toContain('symbol:session:createSession');
    expect(result.entities.map((item) => item.id)).not.toContain('symbol:prefix-collision');
  });
});
