import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { buildRepositoryCorpus, loadCurrentGeneration, loadRepositoryGeneration } from '../src/node.js';
import type { StoredRepositoryGeneration } from '../src/node.js';
import { acquireBuildLock, publishRepositoryGeneration, releaseBuildLock } from '../src/node/store.js';
import { createTemporaryRepository, type TemporaryRepository } from './node-fixtures.js';

vi.mock('node:fs/promises', async (original) => ({ ...await original<typeof import('node:fs/promises')>() }));
vi.mock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>() }));
const repositories: TemporaryRepository[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(repositories.splice(0).map((repository) => repository.cleanup()));
});

const generation = (digit: string): StoredRepositoryGeneration => {
  const generationId = `generation-${digit.repeat(64)}`;
  return {
    schemaVersion: 2, corpusId: 'fixture', generationId, inputDigest: digit.repeat(64),
    scopes: ['src'], languages: ['cpp'], files: [], semanticConfigPath: null, semanticInputs: [],
    configurationDigest: 'config', extractorVersion: 'test', sortingVersion: 'v1',
    corpus: { corpusId: 'fixture', generationId, corpusState: 'current-verified',
      coverage: 'complete-in-declared-scope', entities: [], edges: [] },
  };
};
const prepare = async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  const lock = await acquireBuildLock(repository.indexRoot, 'test');
  await publishRepositoryGeneration(repository.indexRoot, generation('a'), lock);
  return { repository, lock };
};
const names = (repository: TemporaryRepository) => fs.readdir(join(repository.indexRoot, 'generations'));

test.each(['generation', 'pointer'])('keeps current readable after %s publication fails and removes the uncommitted candidate', async (phase) => {
  const { repository, lock } = await prepare();
  const rename = fs.rename;
  const renameSync = fsSync.renameSync;
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (phase === 'generation' && String(to).endsWith(`${generation('b').generationId}.json`)) {
      throw Object.assign(new Error('injected I/O failure'), { code: 'EIO' });
    }
    return rename(from, to);
  });
  vi.spyOn(fsSync, 'renameSync').mockImplementation((from, to) => {
    if (phase === 'pointer' && String(to).endsWith('current.json')) {
      throw Object.assign(new Error('injected I/O failure'), { code: 'EIO' });
    }
    return renameSync(from, to);
  });
  await expect(publishRepositoryGeneration(repository.indexRoot, generation('b'), lock)).rejects.toBeDefined();
  expect(await loadCurrentGeneration(repository.indexRoot)).toEqual(generation('a'));
  expect(await names(repository)).toEqual([`${generation('a').generationId}.json`]);
  expect((await fs.readdir(repository.indexRoot)).sort()).toEqual(['.build-lock', 'current.json', 'generations']);
  await releaseBuildLock(lock);
});

test('retries a current read whose selected file was evicted before opening, without mixing generations', async () => {
  const { repository, lock } = await prepare();
  const readFile = fs.readFile;
  let raced = false;
  vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
    if (!raced && String(args[0]).endsWith(`${generation('a').generationId}.json`)) {
      raced = true;
      await publishRepositoryGeneration(repository.indexRoot, generation('b'), lock);
    }
    return readFile(...args);
  });
  expect(await loadCurrentGeneration(repository.indexRoot)).toEqual(generation('b'));
  expect(raced).toBe(true);
  await releaseBuildLock(lock);
});

test('returns a structured bounded failure for a dangling current pointer', async () => {
  const { repository, lock } = await prepare();
  await fs.unlink(join(repository.indexRoot, 'generations', `${generation('a').generationId}.json`));
  await expect(loadCurrentGeneration(repository.indexRoot)).rejects.toMatchObject({ code: 'GENERATION_NOT_AVAILABLE' });
  await releaseBuildLock(lock);
});

test('fails closed on lost or unrelated locks before deleting history or publishing', async () => {
  const { repository, lock } = await prepare();
  const historical = join(repository.indexRoot, 'generations', `${generation('b').generationId}.json`);
  await fs.writeFile(historical, '{}');
  await fs.writeFile(join(lock.path, 'owner.json'), '{"owner":"another"}\n');
  await expect(publishRepositoryGeneration(repository.indexRoot, generation('c'), lock))
    .rejects.toMatchObject({ code: 'LOCK_NOT_OWNED' });
  expect(await names(repository)).toHaveLength(2);
  await expect(acquireBuildLock(repository.indexRoot, 'other')).rejects.toMatchObject({ code: 'LOCK_STATE_UNKNOWN' });
});

test('refuses traversal in exact references and current pointers before reading outside the store', async () => {
  const { repository, lock } = await prepare();
  await expect(loadRepositoryGeneration(repository.indexRoot, '../../tsconfig'))
    .rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  await fs.writeFile(join(repository.indexRoot, 'current.json'), '{"generationId":"../../tsconfig"}\n');
  await expect(loadCurrentGeneration(repository.indexRoot)).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  await releaseBuildLock(lock);
});

test('does not follow a generations directory link or remove a linked historical entry', async () => {
  const { repository, lock } = await prepare();
  const external = join(repository.rootDir, 'external');
  await fs.mkdir(external);
  const linkedName = `${generation('b').generationId}.json`;
  const externalFile = join(external, linkedName);
  await fs.writeFile(externalFile, 'foreign');
  await fs.symlink(externalFile, join(repository.indexRoot, 'generations', linkedName), 'file');
  await publishRepositoryGeneration(repository.indexRoot, generation('c'), lock);
  expect(await fs.readFile(externalFile, 'utf8')).toBe('foreign');
  expect((await fs.lstat(join(repository.indexRoot, 'generations', linkedName))).isSymbolicLink()).toBe(true);
  await fs.rename(join(repository.indexRoot, 'generations'), join(repository.indexRoot, 'saved'));
  await fs.symlink(external, join(repository.indexRoot, 'generations'), 'junction');
  await expect(publishRepositoryGeneration(repository.indexRoot, generation('d'), lock)).rejects.toBeDefined();
  expect(await fs.readdir(external)).toEqual([linkedName]);
  await releaseBuildLock(lock);
});

test('stops subsequent publication growth when historical cleanup fails, and recovers under the next lock', async () => {
  const { repository, lock } = await prepare();
  await fs.writeFile(join(repository.indexRoot, 'generations', `${generation('b').generationId}.json`), '{}');
  const unlink = fs.unlink;
  const failure = vi.spyOn(fs, 'unlink').mockImplementation(async (path) => {
    if (String(path).endsWith(`${generation('b').generationId}.json`)) {
      throw Object.assign(new Error('injected removal failure'), { code: 'EACCES' });
    }
    return unlink(path);
  });
  await expect(publishRepositoryGeneration(repository.indexRoot, generation('c'), lock))
    .rejects.toMatchObject({ code: 'GENERATION_CLEANUP_FAILED' });
  expect(await loadCurrentGeneration(repository.indexRoot)).toEqual(generation('a'));
  expect(await names(repository)).toHaveLength(2);
  failure.mockRestore();
  await releaseBuildLock(lock);
  const nextLock = await acquireBuildLock(repository.indexRoot, 'next');
  await publishRepositoryGeneration(repository.indexRoot, generation('c'), nextLock);
  expect(await names(repository)).toEqual([`${generation('c').generationId}.json`]);
  await releaseBuildLock(nextLock);
});

test('cancels before pointer commit and releases the build lock while preserving the previous current', async () => {
  const { repository, lock } = await prepare();
  await releaseBuildLock(lock);
  await fs.writeFile(join(repository.rootDir, 'src', 'sample.hpp'), 'class Cancelled {};\n');
  const controller = new AbortController();
  const rename = fs.rename;
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    await rename(from, to);
    if (String(to).includes('generation-') && String(to).endsWith('.json')) controller.abort();
  });
  const options = { rootDir: repository.rootDir, indexRoot: repository.indexRoot, corpusId: 'fixture',
    scopes: ['src/sample.hpp'], languages: ['cpp'] as const, signal: controller.signal };
  await expect(buildRepositoryCorpus(options)).rejects.toMatchObject({ name: 'AbortError' });
  expect(await loadCurrentGeneration(repository.indexRoot)).toEqual(generation('a'));
  expect(await names(repository)).toEqual([`${generation('a').generationId}.json`]);
  await expect(fs.stat(join(repository.indexRoot, '.build-lock'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('finishes an already opened immutable generation even when publication evicts its pathname', async () => {
  const { repository, lock } = await prepare();
  const readFile = fs.readFile;
  let raced = false;
  vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
    if (!raced && String(args[0]).endsWith(`${generation('a').generationId}.json`)) {
      raced = true;
      const handle = await fs.open(String(args[0]), 'r');
      try {
        await publishRepositoryGeneration(repository.indexRoot, generation('b'), lock);
        return await handle.readFile({ encoding: 'utf8' });
      } finally { await handle.close(); }
    }
    return readFile(...args);
  });
  expect(await loadCurrentGeneration(repository.indexRoot)).toEqual(generation('a'));
  expect(await loadCurrentGeneration(repository.indexRoot)).toEqual(generation('b'));
  await releaseBuildLock(lock);
});

test('keeps the committed current when post-commit cleanup fails and bounds the next attempt', async () => {
  const { repository, lock } = await prepare();
  const unlink = fs.unlink;
  const failure = vi.spyOn(fs, 'unlink').mockImplementation(async (path) => {
    if (String(path).endsWith(`${generation('a').generationId}.json`)) {
      throw Object.assign(new Error('injected cleanup failure'), { code: 'EACCES' });
    }
    return unlink(path);
  });
  await expect(publishRepositoryGeneration(repository.indexRoot, generation('b'), lock))
    .rejects.toMatchObject({ code: 'GENERATION_CLEANUP_FAILED' });
  expect(await loadCurrentGeneration(repository.indexRoot)).toEqual(generation('b'));
  await expect(publishRepositoryGeneration(repository.indexRoot, generation('c'), lock))
    .rejects.toMatchObject({ code: 'GENERATION_CLEANUP_FAILED' });
  expect(await names(repository)).toHaveLength(2);
  failure.mockRestore();
  await publishRepositoryGeneration(repository.indexRoot, generation('c'), lock);
  expect(await names(repository)).toEqual([`${generation('c').generationId}.json`]);
  await releaseBuildLock(lock);
});

test('does not roll back or interrupt cleanup when cancellation arrives after the commit', async () => {
  const { repository, lock } = await prepare();
  const controller = new AbortController();
  const renameSync = fsSync.renameSync;
  vi.spyOn(fsSync, 'renameSync').mockImplementation((from, to) => {
    renameSync(from, to);
    if (String(to).endsWith('current.json')) controller.abort();
  });
  await publishRepositoryGeneration(repository.indexRoot, generation('b'), lock, controller.signal);
  expect(await loadCurrentGeneration(repository.indexRoot)).toEqual(generation('b'));
  expect(await names(repository)).toEqual([`${generation('b').generationId}.json`]);
  await releaseBuildLock(lock);
});

test('an already cancelled build does not create an index or lock', async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  const options = { rootDir: repository.rootDir, indexRoot: repository.indexRoot, corpusId: 'fixture',
    scopes: ['src'], languages: ['cpp'] as const, signal: AbortSignal.abort() };
  await expect(buildRepositoryCorpus(options)).rejects.toMatchObject({ name: 'AbortError' });
  await expect(fs.stat(repository.indexRoot)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('does not use a valid lock belonging to another store', async () => {
  const { repository, lock } = await prepare();
  const otherIndex = join(repository.rootDir, 'other-index');
  await expect(publishRepositoryGeneration(otherIndex, generation('b'), lock))
    .rejects.toMatchObject({ code: 'LOCK_NOT_OWNED' });
  await expect(fs.stat(otherIndex)).rejects.toMatchObject({ code: 'ENOENT' });
  await releaseBuildLock(lock);
});

test('refuses a linked index root before creating a lock in its target', async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  const external = join(repository.rootDir, 'external');
  await fs.mkdir(external);
  const linked = join(repository.rootDir, 'linked-index');
  await fs.symlink(external, linked, 'junction');
  await expect(acquireBuildLock(linked, 'test')).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  expect(await fs.readdir(external)).toEqual([]);
});

test('reclaims only owned regular staging files after an interrupted publication', async () => {
  const { repository, lock } = await prepare();
  const staging = '.generated-artifacts-00000000-0000-0000-0000-000000000000.tmp';
  await fs.writeFile(join(repository.indexRoot, staging), 'interrupted pointer');
  await fs.writeFile(join(repository.indexRoot, 'generations', staging), 'interrupted generation');
  await fs.writeFile(join(repository.indexRoot, 'other.tmp'), 'foreign');
  await publishRepositoryGeneration(repository.indexRoot, generation('b'), lock);
  expect((await fs.readdir(repository.indexRoot)).sort()).toEqual(['.build-lock', 'current.json', 'generations', 'other.tmp']);
  expect(await names(repository)).toEqual([`${generation('b').generationId}.json`]);
  await releaseBuildLock(lock);
});

test('does not delete any generation after losing the lock during candidate publication', async () => {
  const { repository, lock } = await prepare();
  const rename = fs.rename;
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    await rename(from, to);
    if (String(to).endsWith(`${generation('b').generationId}.json`)) {
      await fs.writeFile(join(lock.path, 'owner.json'), '{"owner":"another"}\n');
    }
  });
  await expect(publishRepositoryGeneration(repository.indexRoot, generation('b'), lock))
    .rejects.toMatchObject({ code: 'LOCK_NOT_OWNED' });
  expect(await loadCurrentGeneration(repository.indexRoot)).toEqual(generation('a'));
  expect(await names(repository)).toHaveLength(2);
});

test('cancellation during pointer staging cannot commit a new current', async () => {
  const { repository, lock } = await prepare();
  const controller = new AbortController();
  const open = fs.open;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (dirname(String(args[0])) === repository.indexRoot && String(args[0]).includes('.generated-artifacts-')) {
      controller.abort();
    }
    return handle;
  });
  await expect(publishRepositoryGeneration(repository.indexRoot, generation('b'), lock, controller.signal))
    .rejects.toMatchObject({ name: 'AbortError' });
  expect(await loadCurrentGeneration(repository.indexRoot)).toEqual(generation('a'));
  expect(await names(repository)).toEqual([`${generation('a').generationId}.json`]);
  expect((await fs.readdir(repository.indexRoot)).sort()).toEqual(['.build-lock', 'current.json', 'generations']);
  await releaseBuildLock(lock);
});
