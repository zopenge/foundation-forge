import { afterEach, expect, test, vi } from 'vitest';
import { createTemporaryRepository, type TemporaryRepository } from './node-fixtures.js';

const repositories: TemporaryRepository[] = [];
afterEach(async () => Promise.all(repositories.splice(0).map((repository) => repository.cleanup())));

let semanticSnapshotCall = 0;
vi.mock('../src/node/semantic-inputs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/node/semantic-inputs.js')>();
  return {
    ...actual,
    discoverSemanticInputs: vi.fn(async (...args: Parameters<typeof actual.discoverSemanticInputs>) => {
      const snapshot = await actual.discoverSemanticInputs(...args);
      semanticSnapshotCall += 1;
      return semanticSnapshotCall === 4 ? { ...snapshot, digest: 'f'.repeat(64) } : snapshot;
    }),
  };
});

const { buildRepositoryCorpus } = await import('../src/node/build.js');
const { loadCurrentGeneration } = await import('../src/node/store.js');

test('does not advance current when semantic inputs drift between preflight and publication', async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  const options = {
    rootDir: repository.rootDir, indexRoot: repository.indexRoot, corpusId: 'fixture',
    scopes: ['src'] as const, languages: ['typescript'] as const, tsconfigPath: repository.tsconfigPath,
  };

  const first = await buildRepositoryCorpus(options);
  expect(first.status).toBe('ok');
  const firstGenerationId = (await loadCurrentGeneration(repository.indexRoot)).generationId;

  const second = await buildRepositoryCorpus(options);
  expect(second.status).toBe('stale');
  expect(second.diagnostics[0]?.code).toBe('SEMANTIC_INPUT_CHANGED');
  expect((await loadCurrentGeneration(repository.indexRoot)).generationId).toBe(firstGenerationId);
});