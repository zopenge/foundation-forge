import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { extractCpp } from '../src/adapters/cpp.js';

const fixturePath = fileURLToPath(new URL('./fixtures/adapter/sample.hpp', import.meta.url));

describe('C++ lexical adapter', () => {
  test('extracts bounded symbols and include relations with explicit readiness', async () => {
    const result = extractCpp({
      path: 'include/sample.hpp',
      text: await readFile(fixturePath, 'utf8'),
      corpusId: 'fixture',
      generationId: 'g1',
    });

    expect(result.readiness).toBe('ready-for-lexical-evidence');
    expect(result.diagnostics).toEqual([]);
    expect(result.entities.some((entity) => entity.name === 'ICompressor')).toBe(true);
    expect(result.edges.some((edge) => edge.kind === 'includes')).toBe(true);
    expect(result.entities.every((entity) => entity.evidenceLevel === 'literal-path'
      || entity.evidenceLevel === 'lexical-hint')).toBe(true);
  });

  test('rejects blank source instead of returning a file-only success', () => {
    const result = extractCpp({ path: 'empty.hpp', text: '   \n', corpusId: 'fixture', generationId: 'g1' });
    expect(result.readiness).toBe('rejected');
    expect(result.diagnostics[0]?.code).toBe('EMPTY_SOURCE');
  });
});
