import { describe, expect, test } from 'vitest';
import { searchEntities, validateCorpus } from '../src/index.js';
import { corpusFixture } from './repository-fixtures.js';

describe('repository context corpus validation', () => {
  test('rejects duplicate ids', () => {
    expect(validateCorpus(corpusFixture({ duplicateEntity: true })).map((item) => item.code))
      .toContain('DUPLICATE_ENTITY_ID');
  });

  test('binds cursors to the query and generation', () => {
    const first = searchEntities(corpusFixture(), { by: 'text', value: 'session', limit: 1 });
    expect(first.nextCursor).not.toBeNull();
    const mismatch = searchEntities(corpusFixture(), {
      by: 'text',
      value: 'different',
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(mismatch.status).toBe('error');
    expect(mismatch.diagnostics[0]?.code).toBe('CURSOR_MISMATCH');
  });
});
