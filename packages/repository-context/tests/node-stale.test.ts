import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  buildRepositoryCorpus,
  loadCurrentGeneration,
  verifyGenerationCurrent,
} from '../src/node.js';
import { createTemporaryRepository, type TemporaryRepository } from './node-fixtures.js';

const repositories: TemporaryRepository[] = [];
afterEach(async () => Promise.all(repositories.splice(0).map((repository) => repository.cleanup())));

test('marks a generation stale after source content changes', async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  await buildRepositoryCorpus({
    rootDir: repository.rootDir,
    indexRoot: repository.indexRoot,
    corpusId: 'fixture',
    scopes: ['src'],
    languages: ['typescript'],
    tsconfigPath: repository.tsconfigPath,
  });
  const generation = await loadCurrentGeneration(repository.indexRoot);
  await writeFile(join(repository.rootDir, 'src', 'decode.ts'), 'export const changed = true;\n', 'utf8');

  const verification = await verifyGenerationCurrent({ rootDir: repository.rootDir, generation });

  expect(verification.corpusState).toBe('stale');
  expect(verification.diagnostics.map((item) => item.code)).toContain('SOURCE_CHANGED');
});

test('does not advance current when extraction is rejected', async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  const first = await buildRepositoryCorpus({
    rootDir: repository.rootDir,
    indexRoot: repository.indexRoot,
    corpusId: 'fixture',
    scopes: ['src'],
    languages: ['typescript'],
    tsconfigPath: repository.tsconfigPath,
  });
  const rejected = await buildRepositoryCorpus({
    rootDir: repository.rootDir,
    indexRoot: repository.indexRoot,
    corpusId: 'fixture',
    scopes: ['missing'],
    languages: ['typescript'],
    tsconfigPath: repository.tsconfigPath,
  });

  expect(rejected.status).toBe('rejected');
  expect((await loadCurrentGeneration(repository.indexRoot)).generationId).toBe(first.corpus?.generationId);
});
