import { lstat, open, opendir, readlink, realpath, rename, statfs, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { FileIdentity, ManagedPaths, MetadataFile } from './release-context.js';
import { record, ReleaseError } from './errors.js';

export const within = (root: string, path: string): boolean => {
  const value = relative(root, path); return value === '' || (!isAbsolute(value) && value !== '..' && !value.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
};
export const fileIdentity = async (path: string): Promise<FileIdentity> => { const stat = await lstat(path, { bigint: true }); return { dev: stat.dev.toString(), ino: stat.ino.toString() }; };
export const sameIdentity = (a: { readonly dev?: unknown; readonly ino?: unknown }, b: { readonly dev?: unknown; readonly ino?: unknown }): boolean => {
  const canonical = (value: unknown) => typeof value === 'bigint' ? value.toString() : typeof value === 'string' && /^\d+$/u.test(value) ? value : undefined;
  const dev = canonical(a.dev), ino = canonical(a.ino); return dev !== undefined && ino !== undefined && dev === canonical(b.dev) && ino === canonical(b.ino);
};
export async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if (record(error).code === 'ENOENT') return false; throw error; }
}
export async function assertPathChain(root: string, path: string): Promise<void> {
  if (!within(root, path)) throw new ReleaseError('SLOT_PATH');
  const parts = relative(root, path).split(/[\\/]/u).filter(Boolean);
  let current = root;
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) current = resolve(current, parts[index] ?? '');
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || await realpath(current) !== current) throw new ReleaseError('SLOT_PATH', { reason: 'LINK_ANCESTOR' });
      if (!stat.isDirectory() && index < parts.length - 1) throw new ReleaseError('SLOT_PATH');
    } catch (error) { if (record(error).code === 'ENOENT') return; throw error; }
  }
}
export async function readBoundedText(path: string, maxBytes = 1_048_576): Promise<string | undefined> {
  let handle;
  try {
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.size > BigInt(maxBytes)) throw new ReleaseError('SLOT_STATE', { reason: 'FILE_SIZE_OR_TYPE' });
    handle = await open(path, 'r');
    const after = await handle.stat({ bigint: true });
    if (!sameIdentity(before, after)) throw new ReleaseError('SLOT_STATE', { reason: 'FILE_REPLACED' });
    const bytes = Buffer.alloc(maxBytes + 1); let offset = 0;
    while (offset < bytes.length) { const result = await handle.read(bytes, offset, bytes.length - offset, null); if (result.bytesRead === 0) break; offset += result.bytesRead; }
    if (offset > maxBytes) throw new ReleaseError('SLOT_STATE', { reason: 'FILE_SIZE' });
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
  } catch (error) {
    if (record(error).code === 'ENOENT') return undefined;
    if (error instanceof ReleaseError) throw error;
    throw new ReleaseError('SLOT_STATE', { reason: 'JSON_READ' });
  } finally { await handle?.close(); }
}
export async function readBoundedJson(path: string, maxBytes = 1_048_576): Promise<unknown> {
  const text = await readBoundedText(path, maxBytes);
  try { return text === undefined ? undefined : JSON.parse(text) as unknown; }
  catch { throw new ReleaseError('SLOT_STATE', { reason: 'JSON_READ' }); }
}
async function assertInternalLink(root: string, path: string, active: () => void): Promise<void> {
  try {
    if (!within(root, await realpath(path))) throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'EXTERNAL_LINK' });
    return;
  } catch (error) { if (record(error).code !== 'ENOENT') throw error; }
  const separators = (value: string) => process.platform === 'win32' ? value.replaceAll('\\', '/') : value;
  const compare = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  const rootText = separators(root);
  let current = dirname(path), pending: string[] = [], hops = 1;
  const follow = (target: string) => {
    let value = separators(target);
    if (isAbsolute(target)) {
      if (compare(value) !== compare(rootText) && !compare(value).startsWith(`${compare(rootText)}/`)) throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'EXTERNAL_LINK' });
      current = root; value = value.slice(rootText.length);
    } else if (process.platform === 'win32' && /^[a-z]:/iu.test(value)) throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'LINK_TARGET_UNKNOWN' });
    pending = [...value.split('/').filter(Boolean), ...pending];
  };
  follow(await readlink(path));
  // 保留原始组件顺序，先解析已有链接，再解释后续 ..；不能提前作词法折叠。
  while (pending.length > 0) {
    active(); const part = pending.shift();
    if (!part || part === '.') continue;
    if (part === '..') {
      current = dirname(current);
      if (!within(root, current)) throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'EXTERNAL_LINK' });
      continue;
    }
    const candidate = resolve(current, part);
    if (!within(root, candidate)) throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'EXTERNAL_LINK' });
    let stat;
    try { stat = await lstat(candidate); }
    catch (error) {
      if (record(error).code !== 'ENOENT') throw error;
      if (pending.includes('..')) throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'LINK_TARGET_UNKNOWN' });
      return;
    }
    if (stat.isSymbolicLink()) {
      if (hops++ >= 40) throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'LINK_RESOLUTION_LIMIT' });
      follow(await readlink(candidate));
    } else {
      if (!stat.isDirectory() && pending.length > 0) throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'LINK_ANCESTOR_TYPE' });
      current = candidate;
    }
  }
}
export async function measureManagedUsageOnce(paths: ManagedPaths, signal?: AbortSignal): Promise<{ bytes: number; freeBytes: number }> {
  let bytes = 0, entries = 0;
  const active = () => { if (signal?.aborted) throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'OBSERVATION_DEADLINE' }); };
  const visit = async (path: string): Promise<void> => {
    active();
    if (++entries > 500_000) throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'ENTRY_LIMIT' });
    const stat = await lstat(path, { bigint: true });
    if (stat.isSymbolicLink()) {
      await assertInternalLink(paths.slotRoot, path, active);
      if (!sameIdentity(stat, await lstat(path, { bigint: true }))) throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'LINK_REPLACED' });
      bytes += Number(stat.size);
    } else if (stat.isDirectory()) {
      const directory = await opendir(path);
      if (signal?.aborted) { await directory.close(); active(); }
      for await (const entry of directory) await visit(resolve(path, entry.name));
    } else if (stat.isFile()) bytes += Number(stat.size);
    else throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'FILE_TYPE' });
    if (!Number.isSafeInteger(bytes)) throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'SIZE_OVERFLOW' });
  };
  try {
    const assertRoot = async () => {
      if (!sameIdentity(await fileIdentity(paths.slotRoot), paths.slotIdentity) || await realpath(paths.slotRoot) !== paths.slotRoot) throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'ROOT_REPLACED' });
    };
    await assertRoot();
    await visit(paths.slotRoot);
    if (await pathExists(paths.anchorPath)) {
      const stat = await lstat(paths.anchorPath);
      if (!stat.isFile()) throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'ANCHOR_TYPE' });
      bytes += stat.size;
    }
    const volume = await statfs(paths.slotRoot, { bigint: true });
    await assertRoot();
    active();
    const available = volume.bavail * volume.bsize;
    if (available < 0n || available > BigInt(Number.MAX_SAFE_INTEGER)) throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'VOLUME_SIZE' });
    return { bytes, freeBytes: Number(available) };
  } catch (error) { if (error instanceof ReleaseError) throw error; throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'IO_OBSERVATION', ioCode: record(error).code,
    entry: typeof record(error).path === 'string' ? relative(paths.slotRoot, String(record(error).path)) : undefined }); }
}
export async function measureManagedUsage(paths: ManagedPaths, signal?: AbortSignal, scan = measureManagedUsageOnce): Promise<{ bytes: number; freeBytes: number }> {
  for (let attempt = 0; ; attempt++) {
    try { return await scan(paths, signal); }
    catch (error) {
      // 正常 rename 可令已枚举条目消失；丢弃整次扫描，不能累计部分清单。
      if (attempt >= 2 || !(error instanceof ReleaseError) || error.details.reason !== 'IO_OBSERVATION' || error.details.ioCode !== 'ENOENT') throw error;
    }
  }
}
export async function atomicJson(path: string, value: unknown, maxBytes: number, paths: ManagedPaths, guard: () => Promise<void>, maxTotal: number, minFree: number,
  beforeCommit?: (prepared: MetadataFile) => Promise<void>): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  if (bytes.length > maxBytes) throw new ReleaseError('BUDGET_EXCEEDED', { reason: 'METADATA_LIMIT' });
  await guard();
  const usage = await measureManagedUsage(paths);
  // 原文件与原子替换的临时文件会短暂共存，按写入峰值准入。
  if (usage.bytes + bytes.length > maxTotal || usage.freeBytes - bytes.length < minFree) throw new ReleaseError('BUDGET_EXCEEDED', { reason: 'METADATA_ADMISSION' });
  const temporary = resolve(dirname(path), `.${path.slice(dirname(path).length + 1)}.next`);
  const handle = await open(temporary, 'wx'), created = await handle.stat({ bigint: true });
  const prepared = { identity: { dev: created.dev.toString(), ino: created.ino.toString() }, sha256: createHash('sha256').update(bytes).digest('hex') };
  let renamed = false;
  const intact = async () => sameIdentity(created, await lstat(temporary, { bigint: true }))
    && await readBoundedText(temporary, maxBytes) === bytes.toString('utf8');
  try {
    await handle.writeFile(bytes); await handle.sync(); await handle.close();
    // 在目标替换前持久预告暂存文件的精确身份，恢复可区分 rename 两侧的合法状态。
    await beforeCommit?.(prepared); await guard();
    if (!await intact()) throw new ReleaseError('SLOT_STATE', { reason: 'METADATA_TEMP_REPLACED' });
    await rename(temporary, path); renamed = true;
  } finally {
    await handle.close();
    if (!renamed) {
      // 已知失败不遗留本次完整暂存文件；未知归属/内容与崩溃残留仍由恢复门禁处理。
      try { await guard(); if (await pathExists(temporary) && await intact()) await unlink(temporary); } catch { /* 保留首错，不清理无法证明归属的文件。 */ }
    }
  }
}
