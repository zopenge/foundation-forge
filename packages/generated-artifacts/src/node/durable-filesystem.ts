import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { generatedArtifactErrorCodes as codes } from '../contracts.js';
import { GeneratedArtifactError } from '../errors.js';
import { validateArtifactPath } from '../plan.js';
import type { DurableArtifactFilesystem } from './durable-contracts.js';
import { assertSafePath, systemErrorCode, targetPath } from './safe-target.js';

/** 平台适配只承担目录同步；文件 I/O 与发布顺序由共享实现维护。 */
interface DurableDirectoryBackend {
  syncDirectory(path: string): Promise<void>;
}

function rootAndTarget(rootDirectory: string, path: string, allowRoot = false): { root: string; target: string } {
  if (typeof rootDirectory !== 'string' || !isAbsolute(rootDirectory)) throw new GeneratedArtifactError(codes.rootNotAbsolute);
  if (!allowRoot || path !== '') validateArtifactPath(path);
  const root = resolve(rootDirectory);
  return { root, target: allowRoot && path === '' ? root : targetPath(root, path) };
}

async function requireRoot(root: string, path: string): Promise<void> {
  await assertSafePath(root, path, true);
  if (!(await lstat(root)).isDirectory()) throw new GeneratedArtifactError(codes.readFailed, { path, stage: 'root-not-directory' });
}

function failure(cause: unknown, details: Readonly<Record<string, unknown>>, cleanupCause?: unknown): GeneratedArtifactError {
  return new GeneratedArtifactError(cause instanceof GeneratedArtifactError ? cause.code : codes.durabilityUnknown, {
    ...(cause instanceof GeneratedArtifactError ? cause.details : { systemCode: systemErrorCode(cause) }),
    ...details,
    ...(cleanupCause === undefined ? {} : { cleanupFailed: true, cleanupCode: systemErrorCode(cleanupCause) }),
  }, cause);
}

async function syncPublishedFile(path: string, identity: { dev: bigint; ino: bigint }): Promise<void> {
  const handle = await open(path, 'r+');
  let cause: unknown;
  try {
    const actual = await handle.stat({ bigint: true });
    if (!actual.isFile() || actual.dev !== identity.dev || actual.ino !== identity.ino) {
      throw new GeneratedArtifactError(codes.durabilityUnknown, { reason: 'published-identity-changed' });
    }
    await handle.sync();
  } catch (error) { cause = error; }
  try { await handle.close(); } catch (error) { cause = failure(cause ?? error, { closeFailed: true }); }
  if (cause !== undefined) throw cause;
}

export function createDurableArtifactFilesystem(backend: DurableDirectoryBackend): DurableArtifactFilesystem {
  const directories = async (root: string, target: string, logicalPath: string): Promise<void> => {
    await requireRoot(root, logicalPath);
    // 先确认持久根上的平台/权限能力，避免不支持的平台先创建一条未确认的目录链。
    await backend.syncDirectory(root);
    if (target === root) return;
    const segments: string[] = [];
    let current = target;
    while (current !== root) { segments.unshift(current); current = dirname(current); }
    for (const directory of segments) {
      await assertSafePath(directory, logicalPath, true);
      try { await mkdir(directory, { mode: 0o700 }); }
      catch (error) { if (systemErrorCode(error) !== 'EEXIST') throw error; }
      await assertSafePath(directory, logicalPath, true);
      // EEXIST 亦同步：上次失败可能已建目录但尚未确认父目录项持久。
      await backend.syncDirectory(directory);
      await backend.syncDirectory(dirname(directory));
    }
  };
  return {
    ensureDirectory: async (rootDirectory, path = '') => {
      try {
        const { root, target } = rootAndTarget(rootDirectory, path, true);
        await directories(root, target, path);
      } catch (cause) { throw failure(cause, { path, operation: 'ensure-directory', durability: 'unknown' }); }
    },
    publishBytes: async (rootDirectory, path, content, options) => {
      // 在第一个 await 前冻结输入和模式，调用方后续修改不能改变本次发布。
      if (!(content instanceof Uint8Array)) throw new GeneratedArtifactError(codes.invalidContent, { path });
      const snapshot = new Uint8Array(content), mode = options?.mode;
      if (mode !== 'exclusive' && mode !== 'replace') throw new GeneratedArtifactError(codes.invalidOptions, { path });
      let pending: string | undefined, owned = false, attempted = false, stage = 'prepare';
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      let cause: unknown, cleanupCause: unknown;
      try {
        const { root, target } = rootAndTarget(rootDirectory, path), parent = dirname(target);
        await directories(root, parent, path);
        await assertSafePath(target, path);
        pending = join(parent, 'forge-publish-' + randomUUID() + '.tmp');
        stage = 'write';
        handle = await open(pending, 'wx', 0o600);
        owned = true;
        await handle.writeFile(snapshot);
        stage = 'content-sync';
        await handle.sync();
        const identity = await handle.stat({ bigint: true });
        stage = 'content-close';
        const closing = handle; handle = undefined;
        await closing.close();
        await assertSafePath(target, path);
        await assertSafePath(pending, path);
        stage = 'publish'; attempted = true;
        try {
          if (mode === 'exclusive') await link(pending, target);
          else { await rename(pending, target); owned = false; }
        } catch (error) {
          if (mode === 'exclusive' && systemErrorCode(error) === 'EEXIST') {
            attempted = false;
            throw new GeneratedArtifactError(codes.destinationOccupied, { path });
          }
          throw error;
        }
        stage = 'published-content-sync';
        await assertSafePath(target, path);
        await syncPublishedFile(target, identity);
        if (owned) { stage = 'pending-remove'; await unlink(pending); owned = false; }
        stage = 'published-directory-sync';
        await backend.syncDirectory(parent);
      } catch (error) { cause = error; }
      if (handle) {
        try { await handle.close(); } catch (error) { cleanupCause = error; }
      }
      if (owned && pending) {
        try { await assertSafePath(pending, path); await unlink(pending); }
        catch (error) { if (systemErrorCode(error) !== 'ENOENT') cleanupCause ??= error; }
      }
      if (cause !== undefined || cleanupCause !== undefined) {
        throw failure(cause ?? cleanupCause, { path, operation: 'publish-bytes', stage,
          publication: attempted ? 'unknown' : 'not-published', durability: 'unknown' }, cleanupCause);
      }
    },
  };
}
