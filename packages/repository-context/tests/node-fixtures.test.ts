import { readFile } from 'node:fs/promises';
import { afterEach, expect, test, vi } from 'vitest';
import ts from 'typescript';
import { buildRepositoryCorpus } from '../src/node.js';
import { createTemporaryRepository, type TemporaryRepository } from './node-fixtures.js';

const fixtures: TemporaryRepository[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(fixtures.splice(0).map(f => f.cleanup())); });

test('minimal fixture omits unrelated standard libraries while an explicit representative retains them', async () => {
  const minimal = await createTemporaryRepository(), standard = await createTemporaryRepository({ standardLibrary: true });
  fixtures.push(minimal, standard);
  expect(JSON.parse(await readFile(minimal.tsconfigPath, 'utf8')).compilerOptions.noLib).toBe(true);
  expect(JSON.parse(await readFile(standard.tsconfigPath, 'utf8')).compilerOptions.noLib).not.toBe(true);
  const generations = [];
  const reads = vi.spyOn(ts.sys, 'readFile');
  for (const f of fixtures) {
    reads.mockClear();
    const result = await buildRepositoryCorpus({ rootDir: f.rootDir, indexRoot: f.indexRoot, corpusId: 'fixture',
      scopes: ['src'], languages: ['typescript'], tsconfigPath: f.tsconfigPath });
    expect(result.status).toBe('ok');
    expect(result.corpus?.entities.some(entity => entity.name === 'createSession')).toBe(true);
    expect(reads.mock.calls.some(([path]) => /[\\/]lib\.[^\\/]+\.d\.ts$/u.test(path))).toBe(f === standard);
    generations.push(result.generation);
  }
  expect(generations[0]).not.toBe(generations[1]);
  expect(minimal.rootDir).not.toBe(standard.rootDir);
});
