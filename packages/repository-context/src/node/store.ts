import { randomUUID } from 'node:crypto';
import { renameSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { defineGeneratedArtifactPlan } from '@openge/forge-generated-artifacts';
import { publishGeneratedArtifacts } from '@openge/forge-generated-artifacts/node';
import type { StoredRepositoryGeneration } from './contracts.js';
import { assertGenerationId, assertStorePath } from './store-paths.js';

const filesystemOptions = { pathCaseSensitivity: process.platform === 'win32' ? 'case-insensitive' as const : 'case-sensitive' as const };

const parseGeneration = (source: string): StoredRepositoryGeneration => {
  const value = JSON.parse(source) as Readonly<Record<string, unknown>>;
  if (value.schemaVersion === 1) {
    throw Object.assign(new Error('repository generation schema upgrade required'), { code: 'INDEX_SCHEMA_UPGRADE_REQUIRED' });
  }
  if (value.schemaVersion !== 2 || typeof value.corpusId !== 'string' || typeof value.generationId !== 'string'
    || typeof value.inputDigest !== 'string' || !Array.isArray(value.scopes) || !Array.isArray(value.languages)
    || !value.corpus || typeof value.corpus !== 'object' || !Array.isArray(value.files) || !Array.isArray(value.semanticInputs)
    || (value.semanticConfigPath !== null && typeof value.semanticConfigPath !== 'string')
    || typeof value.configurationDigest !== 'string' || typeof value.extractorVersion !== 'string'
    || typeof value.sortingVersion !== 'string') {
    throw Object.assign(new Error('invalid repository generation'), { code: 'CORRUPT_INDEX' });
  }
  return {
    schemaVersion: 2,
    corpusId: value.corpusId,
    generationId: value.generationId,
    inputDigest: value.inputDigest,
    scopes: value.scopes as StoredRepositoryGeneration['scopes'],
    languages: value.languages as StoredRepositoryGeneration['languages'],
    files: value.files as StoredRepositoryGeneration['files'],
    semanticConfigPath: value.semanticConfigPath as string | null,
    semanticInputs: value.semanticInputs as StoredRepositoryGeneration['semanticInputs'],
    configurationDigest: value.configurationDigest,
    extractorVersion: value.extractorVersion,
    sortingVersion: value.sortingVersion,
    corpus: value.corpus as StoredRepositoryGeneration['corpus'],
  };
};

export interface BuildLock {
  readonly owner: string;
  readonly path: string;
}

export const acquireBuildLock = async (indexRoot: string, inputDigest: string): Promise<BuildLock> => {
  const absoluteIndexRoot = resolve(indexRoot);
  await assertStorePath(absoluteIndexRoot, true);
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
    await assertStorePath(join(lock.path, 'owner.json'));
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

const readCurrentId = async (indexRoot: string): Promise<string | null> => {
  const path = join(resolve(indexRoot), 'current.json');
  await assertStorePath(path);
  let source: string;
  try { source = await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let pointer: { readonly generationId?: unknown } | null;
  try { pointer = JSON.parse(source) as typeof pointer; }
  catch { throw Object.assign(new Error('invalid current pointer'), { code: 'CORRUPT_INDEX' }); }
  if (!pointer || typeof pointer.generationId !== 'string') {
    throw Object.assign(new Error('invalid current pointer'), { code: 'CORRUPT_INDEX' });
  }
  return assertGenerationId(pointer.generationId);
};

const generationName = /^generation-[a-f0-9]{64}\.json$/u;
const stagingName = /^\.(?:generated-artifacts|repository-context-current)-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.tmp$/u;

const pruneGenerations = async (indexRoot: string, currentId: string | null, lock: BuildLock): Promise<void> => {
  for (const directory of [resolve(indexRoot), join(resolve(indexRoot), 'generations')]) {
    await assertBuildLockOwned(lock);
    await assertStorePath(directory, true);
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      const managed = stagingName.test(entry.name)
        || (directory !== resolve(indexRoot) && generationName.test(entry.name) && entry.name !== `${currentId}.json`);
      if (!entry.isFile() || !managed) continue;
      await assertBuildLockOwned(lock);
      const path = join(directory, entry.name);
      try {
        await assertStorePath(directory, true);
        // 链接和同名目录不属于可回收快照，禁止递归删除或读取历史正文。
        if ((await lstat(path)).isFile()) await unlink(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw Object.assign(new Error('repository generation cleanup failed'), {
          code: 'GENERATION_CLEANUP_FAILED', details: { file: entry.name, causeCode: (error as NodeJS.ErrnoException).code },
        });
      }
    }
  }
};

const publishCurrent = async (indexRoot: string, generationId: string, lock: BuildLock, signal?: AbortSignal): Promise<void> => {
  const pending = `.repository-context-current-${randomUUID()}.tmp`;
  await publish(indexRoot, pending, { generationId });
  const source = join(resolve(indexRoot), pending);
  const target = join(resolve(indexRoot), 'current.json');
  const retryDelays = [10, 25, 50] as const;
  for (let attempt = 0; ; attempt += 1) {
    await assertStorePath(source);
    await assertStorePath(target);
    await assertBuildLockOwned(lock);
    // 暂存和锁检查均结束后才检查取消；检查与同步 rename 之间没有异步取消窗口。
    signal?.throwIfAborted();
    try { renameSync(source, target); return; }
    catch (error) {
      const wait = retryDelays[attempt];
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM' && wait !== undefined) {
        await delay(wait);
        continue;
      }
      throw Object.assign(new Error('repository pointer publication failed'), {
        code: 'PUBLICATION_FAILED', details: { causeCode: (error as NodeJS.ErrnoException).code },
      });
    }
  }
};

export const publishRepositoryGeneration = async (
  indexRoot: string,
  generation: StoredRepositoryGeneration,
  lock: BuildLock,
  signal?: AbortSignal,
): Promise<void> => {
  if (lock.path !== join(resolve(indexRoot), '.build-lock')) {
    throw Object.assign(new Error('repository context lock is not owned'), { code: 'LOCK_NOT_OWNED' });
  }
  assertGenerationId(generation.generationId);
  signal?.throwIfAborted();
  await assertBuildLockOwned(lock);
  // 先收敛历史和中断遗留，再写一个候选，避免失败重试继续累积完整索引。
  await pruneGenerations(indexRoot, await readCurrentId(indexRoot), lock);
  try {
    signal?.throwIfAborted();
    await publish(indexRoot, `generations/${generation.generationId}.json`, generation);
    await assertBuildLockOwned(lock);
    signal?.throwIfAborted();
    await publishCurrent(indexRoot, generation.generationId, lock, signal);
  } catch (error) {
    // 仅回收实际 current 之外的数据；失锁时不再清理，交给下一次合法构建。
    try { await pruneGenerations(indexRoot, await readCurrentId(indexRoot), lock); }
    catch (cleanupError) {
      throw Object.assign(new AggregateError([error, cleanupError], 'repository publication and cleanup failed'), {
        code: (cleanupError as NodeJS.ErrnoException).code ?? 'PUBLICATION_FAILED',
      });
    }
    throw error;
  }
  // 指针切换是提交点；之后完成回收，不因迟到的取消撤销已发布的 current。
  await assertBuildLockOwned(lock);
  await pruneGenerations(indexRoot, generation.generationId, lock);
};

export const loadRepositoryGeneration = async (
  indexRoot: string,
  generationId: string,
): Promise<StoredRepositoryGeneration> => {
  assertGenerationId(generationId);
  const path = join(resolve(indexRoot), 'generations', `${generationId}.json`);
  await assertStorePath(path);
  let source: string;
  try { source = await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    throw Object.assign(new Error('repository generation is not available'), {
      code: 'GENERATION_NOT_AVAILABLE', details: { generationId },
    });
  }
  const generation = parseGeneration(source);
  if (generation.generationId !== generationId) {
    throw Object.assign(new Error('generation id mismatch'), { code: 'CORRUPT_INDEX' });
  }
  return generation;
};

export const loadCurrentGeneration = async (indexRoot: string): Promise<StoredRepositoryGeneration> => {
  for (let attempt = 0; ; attempt += 1) {
    const generationId = await readCurrentId(indexRoot);
    if (generationId === null) throw Object.assign(new Error('repository index is not available'), { code: 'ENOENT' });
    try { return await loadRepositoryGeneration(indexRoot, generationId); }
    catch (error) {
      // 已打开的文件可完整读完；只有旧指针在打开前被淘汰时才重读，且重试有界。
      if ((error as NodeJS.ErrnoException).code !== 'GENERATION_NOT_AVAILABLE' || attempt >= 2) throw error;
    }
  }
};
