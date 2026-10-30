import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { buildRepositoryCorpus, loadCurrentGeneration, loadRepositoryGeneration } from '../src/node.js';
import { createTemporaryRepository, type TemporaryRepository } from './node-fixtures.js';

const repositories: TemporaryRepository[] = [];
afterEach(async () => Promise.all(repositories.splice(0).map((repository) => repository.cleanup())));

const prepare = async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  await writeFile(join(repository.rootDir, 'src', 'sample.hpp'), 'class First {};\n');
  const build = () => buildRepositoryCorpus({
    rootDir: repository.rootDir, indexRoot: repository.indexRoot, corpusId: 'fixture',
    scopes: ['src/sample.hpp'], languages: ['cpp'],
  });
  return { repository, build, generations: join(repository.indexRoot, 'generations') };
};

test('bounds repeated changed builds to the complete current generation and diagnoses evicted exact references', async () => {
  const { repository, build, generations } = await prepare();
  const first = await build();
  expect(first.status).toBe('ok');
  if (!first.generation) throw new Error('missing generation');
  for (let index = 0; index < 5; index += 1) {
    await writeFile(join(repository.rootDir, 'src', 'sample.hpp'), `class Changed${index} {};\n`);
    const result = await build();
    expect(result.status).toBe('ok');
    expect(await readdir(generations)).toEqual([`${result.generation?.generationId}.json`]);
    expect(await loadCurrentGeneration(repository.indexRoot)).toEqual(result.generation);
  }
  await expect(loadRepositoryGeneration(repository.indexRoot, first.generation.generationId))
    .rejects.toMatchObject({ code: 'GENERATION_NOT_AVAILABLE', details: { generationId: first.generation.generationId } });
});

test('reuses unchanged bytes while reclaiming a batch of historical and interrupted generations', async () => {
  const { build, generations } = await prepare();
  const first = await build();
  if (!first.generation) throw new Error('missing generation');
  const path = join(generations, `${first.generation.generationId}.json`);
  const before = await stat(path);
  for (let index = 0; index < 40; index += 1) {
    await writeFile(join(generations, `generation-${index.toString(16).padStart(64, '0')}.json`), '{}\n');
  }
  await writeFile(join(generations, 'notes.json'), 'foreign\n');
  await mkdir(join(generations, `generation-${'f'.repeat(64)}.json`));
  const second = await build();
  expect(second.generation).toEqual(first.generation);
  expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
  expect((await readdir(generations)).sort()).toEqual([
    `${first.generation.generationId}.json`, `generation-${'f'.repeat(64)}.json`, 'notes.json',
  ].sort());
});
