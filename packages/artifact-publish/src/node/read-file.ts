import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { parse, resolve, sep } from 'node:path';
import { resolveExistingPathWithinRoot, resolvePathWithinRoot } from '@openge/forge-path-safety/node';
import type { OperationBudget } from '../budget.js';
import type { ArtifactObjectDescriptor } from '../contracts.js';
import { ArtifactPublicationError } from '../errors.js';

async function assertRegularPath(target: string, budget: OperationBudget): Promise<void> {
  const volume = parse(target).root;
  const components = target.slice(volume.length).split(sep).filter(Boolean);
  let current = volume;
  for (const component of ['', ...components]) {
    if (component) current = resolve(current, component);
    budget.assertActive();
    const metadata = await lstat(current);
    budget.assertActive();
    if (metadata.isSymbolicLink() || (current === target ? !metadata.isFile() : !metadata.isDirectory())) {
      throw new ArtifactPublicationError('INVALID_SOURCE');
    }
  }
}

export async function readControlledFile(root: string, path: string, expected: ArtifactObjectDescriptor,
  budget: OperationBudget): Promise<Uint8Array> {
  let handle: FileHandle | undefined;
  let bytes: Uint8Array | undefined;
  let failure: ArtifactPublicationError | undefined;
  try {
    const target = resolvePathWithinRoot(root, path);
    await assertRegularPath(target, budget);
    await resolveExistingPathWithinRoot(root, path);
    budget.assertActive();
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    await assertRegularPath(target, budget);
    const [opened, current] = await Promise.all([handle.stat(), lstat(target)]);
    budget.assertActive();
    if (!opened.isFile() || opened.ino !== current.ino || opened.dev !== current.dev) throw new ArtifactPublicationError('INVALID_SOURCE');
    if (opened.size !== expected.byteLength) throw new ArtifactPublicationError('INTEGRITY_MISMATCH');
    // 多读至多一个字节来检测读取期间增长；不使用不受声明长度约束的 readFile。
    const buffer = Buffer.alloc(expected.byteLength + 1);
    let count = 0;
    while (count < buffer.length) {
      budget.assertActive();
      const { bytesRead } = await handle.read(buffer, count, Math.min(65_536, buffer.length - count), count);
      budget.assertActive();
      if (bytesRead === 0) break;
      count += bytesRead;
    }
    if (count !== expected.byteLength) throw new ArtifactPublicationError('INTEGRITY_MISMATCH');
    bytes = buffer.subarray(0, count);
  } catch (error) {
    failure = error instanceof ArtifactPublicationError ? error : new ArtifactPublicationError('INVALID_SOURCE');
  } finally {
    if (handle) {
      try { await handle.close(); }
      catch {
        budget.markUnconfirmedResource();
        failure ??= new ArtifactPublicationError('CLOSURE_UNCONFIRMED');
      }
    }
  }
  if (failure) throw new ArtifactPublicationError(failure.code, { key: expected.key });
  if (!bytes) throw new ArtifactPublicationError('INVALID_SOURCE', { key: expected.key });
  return bytes;
}
