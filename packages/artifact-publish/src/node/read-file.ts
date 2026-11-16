import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { parse, resolve, sep } from 'node:path';
import { resolveExistingPathWithinRoot, resolvePathWithinRoot } from '@openge/forge-path-safety/node';
import type { OperationBudget } from '../budget.js';
import type { ArtifactObjectDescriptor } from '../contracts.js';
import { ArtifactPublicationError } from '../errors.js';

export const fileStamp = (info: BigIntStats): string => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.mode, info.nlink].join(':');

export async function assertRegularPath(target: string, budget: OperationBudget, kind: 'file' | 'directory' = 'file'): Promise<void> {
  const volume = parse(target).root;
  const components = target.slice(volume.length).split(sep).filter(Boolean);
  let current = volume;
  for (const component of ['', ...components]) {
    if (component) current = resolve(current, component);
    budget.assertActive();
    const metadata = await lstat(current);
    budget.assertActive();
    if (metadata.isSymbolicLink() || (current === target && kind === 'file' ? !metadata.isFile() : !metadata.isDirectory())) {
      throw new ArtifactPublicationError('INVALID_SOURCE');
    }
  }
}

export async function readControlledFile(root: string, path: string, expected: ArtifactObjectDescriptor,
  budget: OperationBudget): Promise<Uint8Array> {
  try { return (await captureControlledFile(root, path, expected.byteLength, budget, expected.byteLength)).bytes; }
  catch (error) {
    throw new ArtifactPublicationError(error instanceof ArtifactPublicationError ? error.code : 'INVALID_SOURCE', { key: expected.key });
  }
}

export interface ControlledFileCapture { readonly bytes: Uint8Array; readonly canonicalPath: string; verify(): Promise<void> }

export async function captureControlledFile(root: string, path: string, maximum: number,
  budget: OperationBudget, expectedLength?: number): Promise<ControlledFileCapture> {
  let handle: FileHandle | undefined;
  let bytes: Uint8Array | undefined;
  let failure: ArtifactPublicationError | undefined;
  const target = resolvePathWithinRoot(root, path);
  let stamp = '', canonicalPath = '';
  try {
    await assertRegularPath(target, budget);
    canonicalPath = await resolveExistingPathWithinRoot(root, path);
    budget.assertActive();
    const before = await lstat(target, { bigint: true });
    stamp = fileStamp(before);
    if (expectedLength !== undefined && before.size !== BigInt(expectedLength)) throw new ArtifactPublicationError('INTEGRITY_MISMATCH');
    if (before.size > BigInt(maximum)) throw new ArtifactPublicationError('BUDGET_EXCEEDED');
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    await assertRegularPath(target, budget);
    const [opened, current] = await Promise.all([handle.stat({ bigint: true }), lstat(target, { bigint: true })]);
    budget.assertActive();
    if (!opened.isFile() || fileStamp(opened) !== stamp || fileStamp(current) !== stamp) throw new ArtifactPublicationError('INTEGRITY_MISMATCH');
    // 多读至多一个字节来检测读取期间增长；不使用不受声明长度约束的 readFile。
    const length = Number(before.size), buffer = Buffer.alloc(length + 1);
    let count = 0;
    while (count < buffer.length) {
      budget.assertActive();
      const { bytesRead } = await handle.read(buffer, count, Math.min(65_536, buffer.length - count), count);
      budget.assertActive();
      if (bytesRead === 0) break;
      count += bytesRead;
    }
    if (count !== length || fileStamp(await handle.stat({ bigint: true })) !== stamp
      || fileStamp(await lstat(target, { bigint: true })) !== stamp) throw new ArtifactPublicationError('INTEGRITY_MISMATCH');
    bytes = buffer.subarray(0, count);
  } catch (error) {
    failure = error instanceof ArtifactPublicationError ? error : new ArtifactPublicationError('INVALID_SOURCE');
  } finally {
    if (handle) {
      try { await handle.close(); }
      catch {
        budget.markUnconfirmedResource();
        failure = new ArtifactPublicationError('CLOSURE_UNCONFIRMED');
      }
    }
  }
  if (failure) throw failure;
  if (!bytes) throw new ArtifactPublicationError('INVALID_SOURCE');
  const verify = async () => {
    await assertRegularPath(target, budget);
    if (await resolveExistingPathWithinRoot(root, path) !== canonicalPath) throw new ArtifactPublicationError('INTEGRITY_MISMATCH');
    if (fileStamp(await lstat(target, { bigint: true })) !== stamp) throw new ArtifactPublicationError('INTEGRITY_MISMATCH');
    budget.assertActive();
  };
  await verify();
  return { bytes, canonicalPath, verify };
}
