import { afterEach, expect, test } from 'vitest';
import { buildRepositoryCorpus } from '../src/node.js';
import { createTemporaryRepository, type TemporaryRepository } from './node-fixtures.js';

const repositories: TemporaryRepository[] = [];
afterEach(async () => Promise.all(repositories.splice(0).map((repository) => repository.cleanup())));

test.each(['../outside', 'C:/outside'])('rejects unsafe scope %s', async (scope) => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  await expect(buildRepositoryCorpus({
    rootDir: repository.rootDir,
    indexRoot: repository.indexRoot,
    corpusId: 'fixture',
    scopes: [scope],
    languages: ['typescript'],
    tsconfigPath: repository.tsconfigPath,
  })).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
});
