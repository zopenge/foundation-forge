import { randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { generatedArtifactErrorCodes as codes } from '../contracts.js';
import { GeneratedArtifactError } from '../errors.js';
import { assertSafePath, ensureParentDirectories, systemErrorCode, targetPath } from './safe-target.js';

export async function atomicWriteArtifact(root: string, path: string, content: Uint8Array): Promise<void> {
  const target = targetPath(root, path);
  const temporary = join(dirname(target), '.generated-artifacts-' + randomUUID() + '.tmp');
  let handle;
  let created = false;
  let failure: unknown;
  try {
    await ensureParentDirectories(target, path);
    await assertSafePath(target, path);
    handle = await open(temporary, 'wx', 0o600);
    created = true;
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertSafePath(target, path);
    await assertSafePath(temporary, path);
    await rename(temporary, target);
    created = false;
  } catch (cause) { failure = cause; }
  finally {
    try { await handle?.close(); }
    catch (cause) { failure ??= cause; }
    if (created) {
      try { await assertSafePath(temporary, path); await unlink(temporary); }
      catch (cause) {
        if (systemErrorCode(cause) !== 'ENOENT') {
          const originalCode = failure instanceof GeneratedArtifactError ? failure.code : codes.writeFailed;
          failure = new GeneratedArtifactError(originalCode, { path, cleanupFailed: true, cleanupCode: cause instanceof GeneratedArtifactError ? cause.code : systemErrorCode(cause) }, failure);
        }
      }
    }
  }
  if (failure !== undefined) {
    if (failure instanceof GeneratedArtifactError) throw failure;
    throw new GeneratedArtifactError(codes.writeFailed, { path, operation: 'atomic-write', systemCode: systemErrorCode(failure) }, failure);
  }
}
