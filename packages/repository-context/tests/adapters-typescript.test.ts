import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { extractTypeScript } from '../src/adapters/typescript.js';

const rootDir = fileURLToPath(new URL('./fixtures/adapter/', import.meta.url));
const tsconfigPath = fileURLToPath(new URL('./fixtures/adapter/tsconfig.json', import.meta.url));

describe('TypeScript and JavaScript adapter', () => {
  test('extracts declarations and imports from a non-empty mjs input', async () => {
    const result = await extractTypeScript({
      rootDir,
      tsconfigPath,
      files: ['sample.mjs', 'sample.ts'],
      corpusId: 'fixture',
      generationId: 'g1',
    });

    expect(result.readiness).toBe('ready');
    expect(result.diagnostics).toEqual([]);
    expect(result.entities.some((entity) => entity.kind === 'symbol' && entity.name === 'createSample')).toBe(true);
    expect(result.entities.some((entity) => entity.kind === 'symbol' && entity.name === 'decodeSample')).toBe(true);
    expect(result.edges.some((edge) => edge.kind === 'imports')).toBe(true);
  });

  test('rejects an empty input set instead of returning an empty success', async () => {
    const result = await extractTypeScript({
      rootDir,
      tsconfigPath,
      files: [],
      corpusId: 'fixture',
      generationId: 'g1',
    });
    expect(result.readiness).toBe('rejected');
    expect(result.diagnostics[0]?.code).toBe('EMPTY_INPUT_SET');
  });
});
