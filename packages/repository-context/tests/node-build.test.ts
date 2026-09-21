import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { buildRepositoryCorpus, loadCurrentGeneration } from '../src/node.js';
import { appendAll } from '../src/node/build.js';
import { createTemporaryRepository, type TemporaryRepository } from './node-fixtures.js';

const repositories: TemporaryRepository[] = [];
afterEach(async () => Promise.all(repositories.splice(0).map((repository) => repository.cleanup())));

describe('repository corpus build', () => {
  test('appends extractor results beyond the JavaScript argument limit', () => {
    const values = Array.from({ length: 200_000 }, (_, index) => index);
    const target: number[] = [];

    appendAll(target, values);

    expect(target).toHaveLength(values.length);
    expect(target.at(-1)).toBe(values.length - 1);
  });

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

  test('excludes conventional derived output directories from declared scopes', async () => {
    const repository = await createTemporaryRepository();
    repositories.push(repository);
    await mkdir(join(repository.rootDir, 'src', 'dist'), { recursive: true });
    await writeFile(
      join(repository.rootDir, 'src', 'dist', 'generated.ts'),
      'export const generatedOnly = true;\n',
      'utf8',
    );

    const result = await buildRepositoryCorpus({
      rootDir: repository.rootDir,
      indexRoot: repository.indexRoot,
      corpusId: 'fixture',
      scopes: ['src'],
      languages: ['typescript'],
      tsconfigPath: repository.tsconfigPath,
    });

    expect(result.status).toBe('ok');
    expect(result.generation?.files.map((file) => file.path)).not.toContain('src/dist/generated.ts');
    expect(result.corpus?.entities.some((entity) => entity.name === 'generatedOnly')).toBe(false);
  });
});
