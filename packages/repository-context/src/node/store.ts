import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { defineGeneratedArtifactPlan } from '@openge/forge-generated-artifacts';
import { publishGeneratedArtifacts } from '@openge/forge-generated-artifacts/node';
import type { StoredRepositoryGeneration } from './contracts.js';

const filesystemOptions = { pathCaseSensitivity: process.platform === 'win32' ? 'case-insensitive' as const : 'case-sensitive' as const };

const parseGeneration = (source: string): StoredRepositoryGeneration => {
  const value = JSON.parse(source) as Partial<StoredRepositoryGeneration>;
  if (value.schemaVersion !== 1 || typeof value.generationId !== 'string' || !value.corpus) {
    throw Object.assign(new Error('invalid repository generation'), { code: 'CORRUPT_INDEX' });
  }
  return value as StoredRepositoryGeneration;
};

export interface BuildLock {
  readonly owner: string;
  readonly path: string;
}

export const acquireBuildLock = async (indexRoot: string, inputDigest: string): Promise<BuildLock> => {
  const absoluteIndexRoot = resolve(indexRoot);
  await mkdir(absoluteIndexRoot, { recursive: true });
  const path = join(absoluteIndexRoot, '.build-lock');
  const owner = randomUUID();
  try {
    await mkdir(path, { recursive: false });
    await writeFile(join(path, 'owner.json'), `${JSON.stringify({ owner, pid: process.pid, inputDigest })}\n`, 'utf8');
    return { owner, path };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw Object.assign(new Error('repository context lock state is unknown'), { code: 'LOCK_STATE_UNKNOWN' });
    }
    throw error;
  }
};

export const assertBuildLockOwned = async (lock: BuildLock): Promise<void> => {
  try {
    const value = JSON.parse(await readFile(join(lock.path, 'owner.json'), 'utf8')) as { readonly owner?: unknown };
    if (value.owner !== lock.owner) throw Object.assign(new Error('repository context lock is not owned'), { code: 'LOCK_NOT_OWNED' });
  } catch (error) {
    if ((error as { readonly code?: unknown }).code === 'LOCK_NOT_OWNED') throw error;
    throw Object.assign(new Error('repository context lock is not owned'), { code: 'LOCK_NOT_OWNED' });
  }
};

export const releaseBuildLock = async (lock: BuildLock): Promise<void> => {
  await assertBuildLockOwned(lock);
  await rm(lock.path, { recursive: true, force: false });
};

const publish = async (indexRoot: string, path: string, value: unknown): Promise<void> => {
  const plan = defineGeneratedArtifactPlan({ artifacts: [{ path, content: `${JSON.stringify(value)}\n` }] });
  const result = await publishGeneratedArtifacts(resolve(indexRoot), plan, filesystemOptions);
  if (result.diagnostics.length > 0) {
    throw Object.assign(new Error('repository generation publication failed'), {
      code: 'PUBLICATION_FAILED', details: { diagnostics: result.diagnostics },
    });
  }
};

export const publishRepositoryGeneration = async (
  indexRoot: string,
  generation: StoredRepositoryGeneration,
  lock: BuildLock,
): Promise<void> => {
  await assertBuildLockOwned(lock);
  await publish(indexRoot, `generations/${generation.generationId}.json`, generation);
  await assertBuildLockOwned(lock);
  await publish(indexRoot, 'current.json', { generationId: generation.generationId });
};

export const loadRepositoryGeneration = async (
  indexRoot: string,
  generationId: string,
): Promise<StoredRepositoryGeneration> => {
  const generation = parseGeneration(await readFile(join(resolve(indexRoot), 'generations', `${generationId}.json`), 'utf8'));
  if (generation.generationId !== generationId) {
    throw Object.assign(new Error('generation id mismatch'), { code: 'CORRUPT_INDEX' });
  }
  return generation;
};

export const loadCurrentGeneration = async (indexRoot: string): Promise<StoredRepositoryGeneration> => {
  const pointer = JSON.parse(await readFile(join(resolve(indexRoot), 'current.json'), 'utf8')) as { readonly generationId?: unknown };
  if (typeof pointer.generationId !== 'string') {
    throw Object.assign(new Error('invalid current pointer'), { code: 'CORRUPT_INDEX' });
  }
  return loadRepositoryGeneration(indexRoot, pointer.generationId);
};
