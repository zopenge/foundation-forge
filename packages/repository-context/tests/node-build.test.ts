import { afterEach, describe, expect, test } from 'vitest';
import { buildRepositoryCorpus, loadCurrentGeneration } from '../src/node.js';
import { createTemporaryRepository, type TemporaryRepository } from './node-fixtures.js';

const repositories: TemporaryRepository[] = [];
afterEach(async () => Promise.all(repositories.splice(0).map((repository) => repository.cleanup())));

describe('repository corpus build', () => {
  test('publishes a current verified generation after complete extraction', async () => {
    const repository = await createTemporaryRepository();
    repositories.push(repository);
    const result = await buildRepositoryCorpus({
      rootDir: repository.rootDir,
      indexRoot: repository.indexRoot,
      corpusId: 'fixture',
      scopes: ['src'],
      languages: ['typescript'],
      tsconfigPath: repository.tsconfigPath,
    });

    expect(result.status).toBe('ok');
    expect(result.corpus?.corpusState).toBe('current-verified');
    expect(result.corpus?.entities.some((entity) => entity.name === 'createSession')).toBe(true);
    expect(await loadCurrentGeneration(repository.indexRoot)).toMatchObject({
      generationId: result.corpus?.generationId,
    });
  });
});
