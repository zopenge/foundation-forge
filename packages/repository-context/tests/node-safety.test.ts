import { dirname, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { buildRepositoryCorpus } from '../src/node.js';
import { createTemporaryRepository, type TemporaryRepository } from './node-fixtures.js';
import { discoverSourceSnapshot } from '../src/node/discovery.js';

const repositories: TemporaryRepository[] = [];
afterEach(async () => Promise.all(repositories.splice(0).map((repository) => repository.cleanup())));

test('默认排除新的临时子目录，生成文件不会反向进入源码指纹', async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  await mkdir(resolve(repository.rootDir, 'src/tmp'));
  await writeFile(resolve(repository.rootDir, 'src/tmp/generated.ts'), 'export const generated = true;');
  const snapshot = await discoverSourceSnapshot(repository.rootDir, ['src'], ['typescript']);
  expect(snapshot.files.map(file => file.path)).toEqual(['src/decode.ts', 'src/session.ts']);
});

test.each(['../outside', 'C:/outside'])('rejects unsafe scope %s', async (scope) => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  expect(dirname(repository.rootDir))
    .toBe(resolve(fileURLToPath(new URL('../../../tmp/tests/', import.meta.url))));
  await expect(buildRepositoryCorpus({
    rootDir: repository.rootDir,
    indexRoot: repository.indexRoot,
    corpusId: 'fixture',
    scopes: [scope],
    languages: ['typescript'],
    tsconfigPath: repository.tsconfigPath,
  })).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
});
