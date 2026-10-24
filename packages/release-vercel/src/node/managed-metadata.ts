import { createHash } from 'node:crypto';
import { lstat, open, rename, statfs, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { ManagedPaths, MetadataFile } from './release-context.js';
export type { MetadataFile } from './release-context.js';
import { assertPathChain, fileIdentity, pathExists, readBoundedText, sameIdentity } from './managed-io.js';
import { ReleaseError } from './errors.js';

export const metadataReserveBytes = 1_048_576;
export const terminalLimit = 262_144;
export const metadataDigest = (value: string): string => createHash('sha256').update(value).digest('hex');
export const sameMetadataFile = (left: MetadataFile | null, right: MetadataFile | null): boolean =>
  left === null ? right === null : right !== null && left.sha256 === right.sha256 && sameIdentity(left.identity, right.identity);
export async function inspectMetadataFile(path: string, limit = 1_048_576): Promise<MetadataFile | null> {
  const before = await pathExists(path) ? await fileIdentity(path) : undefined;
  const text = await readBoundedText(path, limit);
  const after = await pathExists(path) ? await fileIdentity(path) : undefined;
  if (before ? !after || !sameIdentity(before, after) || text === undefined : after || text !== undefined) throw new ReleaseError('SLOT_STATE', { reason: 'METADATA_REPLACED' });
  return text === undefined || !after ? null : { identity: after, sha256: metadataDigest(text) };
}
export async function assertMetadataFile(path: string, expected: MetadataFile | null, limit = 1_048_576): Promise<void> {
  const current = await inspectMetadataFile(path, limit);
  if (!sameMetadataFile(current, expected)) {
    throw new ReleaseError('SLOT_STATE', { reason: 'METADATA_REPLACED' });
  }
}
/** 仅核对元数据边界；故障 payload 仍由独立的执行/预算门禁拒绝。 */
export async function assertMetadataPaths(paths: ManagedPaths): Promise<void> {
  await assertPathChain(paths.sourceRoot, paths.slotRoot); await assertPathChain(paths.sourceRoot, paths.anchorPath);
  if (!sameIdentity(await fileIdentity(paths.sourceRoot), paths.sourceIdentity) || !sameIdentity(await fileIdentity(paths.slotRoot), paths.slotIdentity)
    || paths.sourceIdentity.dev !== paths.slotIdentity.dev) throw new ReleaseError('SLOT_PATH', { reason: 'ROOT_REPLACED' });
  for (const path of [paths.ownershipPath, paths.statePath, paths.lockPath, paths.recoveryLockPath]) await assertPathChain(paths.slotRoot, path);
}
export async function writeReservedMetadata(path: string, value: unknown, paths: ManagedPaths, minFreeBytes: number, guard: () => Promise<void>): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > terminalLimit) throw new ReleaseError('BUDGET_EXCEEDED', { reason: 'TERMINAL_LIMIT' });
  await guard(); await assertMetadataPaths(paths); await assertPathChain(paths.slotRoot, path);
  const volume = await statfs(paths.slotRoot, { bigint: true });
  if (volume.bavail * volume.bsize - BigInt(bytes.length) < BigInt(minFreeBytes)) throw new ReleaseError('BUDGET_EXCEEDED', { reason: 'TERMINAL_FREE_SPACE' });
  const temporary = resolve(dirname(path), `.${path.slice(dirname(path).length + 1)}.next`);
  await assertPathChain(paths.slotRoot, temporary);
  const handle = await open(temporary, 'wx'), created = await handle.stat({ bigint: true });
  let renamed = false;
  try {
    await handle.writeFile(bytes); await handle.sync(); await handle.close();
    await guard(); await assertMetadataPaths(paths); await assertPathChain(paths.slotRoot, path);
    if (!sameIdentity(created, await lstat(temporary, { bigint: true }))) throw new ReleaseError('SLOT_STATE', { reason: 'TERMINAL_TEMP_REPLACED' });
    await rename(temporary, path); renamed = true;
  } finally {
    await handle.close();
    if (!renamed) {
      // 仅回收本次创建且身份仍匹配的暂存文件；异常边界下保留证据。
      try { await assertMetadataPaths(paths); if (await pathExists(temporary) && sameIdentity(created, await lstat(temporary, { bigint: true }))) await unlink(temporary); } catch { /* 不掩盖原始写入失败。 */ }
    }
  }
}
