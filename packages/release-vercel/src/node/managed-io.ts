import { lstat, open, opendir, readlink, realpath, rename, statfs, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { FileIdentity, ManagedPaths, MetadataFile } from './managed-state-contracts.js';
import { record, ReleaseError } from './errors.js';
import type { ScanFailureWitness } from './managed-scan-witness.js';

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
export interface ManagedUsageProgress {
  failureWitness?: ScanFailureWitness;
  entriesVisited: number;
  phase: 'path-guard' | 'scan' | 'root' | 'entry' | 'link' | 'directory-open' | 'directory-read' | 'anchor' | 'volume' | 'complete';
}
const entryLimit = 500_000;
const canRescanUsage = (error: unknown): boolean => error instanceof ReleaseError
  ? error.code === 'BUDGET_UNKNOWN' && error.details.rescanBlockedBy === undefined && (
    error.details.reason === 'IO_OBSERVATION' && error.details.ioCode === 'ENOENT'
    || error.details.reason === 'DIRECTORY_REPLACED' && error.details.change === 'identity' && error.details.scope === 'checkout-entry')
  : record(error).code === 'ENOENT';
const directoryScope = (paths: ManagedPaths, path: string) => path === paths.slotRoot ? 'slot-root'
  : path === paths.checkoutRoot ? 'checkout-root' : within(resolve(paths.checkoutRoot, '.git'), path) ? 'checkout-metadata'
    : within(paths.checkoutRoot, path) ? 'checkout-entry' : 'slot-entry';
async function assertDirectoryIdentity(paths: ManagedPaths, path: string, before: { readonly dev: bigint; readonly ino: bigint }): Promise<void> {
  const after = await lstat(path, { bigint: true });
  const change = after.isSymbolicLink() ? 'link' : !after.isDirectory() ? 'type' : await realpath(path) !== path ? 'namespace'
    : !sameIdentity(before, after) ? 'identity' : undefined;
  if (change) {
    const entry = relative(paths.slotRoot, path) || '.', bounded = Array.from(entry).slice(0, 512).join('');
    throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'DIRECTORY_REPLACED', change, scope: directoryScope(paths, path),
      entry: bounded, entryTruncated: bounded !== entry,
      before: { dev: before.dev.toString(), ino: before.ino.toString() }, after: { dev: after.dev.toString(), ino: after.ino.toString() } });
  }
}
export async function readManagedDirectoryNames(path: string, maxEntries: number, signal?: AbortSignal,
  progress?: ManagedUsageProgress, inspectEntry?: () => void): Promise<string[]> {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0 || maxEntries > entryLimit) throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'ENTRY_LIMIT' });
  const active = () => { if (signal?.aborted) throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'OBSERVATION_DEADLINE' }); };
  const directory = await opendir(path);
  if (signal?.aborted) { await directory.close(); active(); }
  if (progress) progress.phase = 'directory-read';
  const children: string[] = [];
  // Windows 搜索句柄会阻止安装器重命名子树；先关闭一层枚举，再逐项读取新鲜元数据。
  for await (const entry of directory) {
    active();
    if (children.length >= maxEntries) throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'ENTRY_LIMIT' });
    inspectEntry?.();
    children.push(entry.name);
  }
  return children;
}
export async function measureManagedUsageOnce(paths: ManagedPaths, signal?: AbortSignal, progress?: ManagedUsageProgress): Promise<{ bytes: number; freeBytes: number }> {
  let bytes = 0, entries = 0, pendingEntries = 0;
  let availableBranches = 3, failed = false, failure: unknown, rescanBlockedBy: string | undefined;
  const phase = (value: ManagedUsageProgress['phase']) => { if (progress) { progress.phase = value; progress.entriesVisited = entries; } };
  const fail = (error: unknown, path?: string, operation?: 'directory-validation') => {
    if (!canRescanUsage(error)) {
      const reason = error instanceof ReleaseError ? error.details.reason : undefined;
      if (rescanBlockedBy === undefined) progress?.failureWitness?.block(error, paths, { path, operation });
      rescanBlockedBy ??= typeof reason === 'string' ? reason : 'IO_OBSERVATION';
    }
    if (!failed) { progress?.failureWitness?.first(error, paths, { path, operation }); failed = true; failure = error; } return failure;
  };
  const active = () => {
    if (failed) throw failure;
    if (signal?.aborted) throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'OBSERVATION_DEADLINE' });
  };
  const reserveEntry = () => {
    active();
    if (entries + pendingEntries >= entryLimit) throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'ENTRY_LIMIT' });
    pendingEntries++;
  };
  const visit = async (path: string): Promise<void> => {
    const branches = new Set<Promise<void>>();
    let directoryBefore: { readonly dev: bigint; readonly ino: bigint } | undefined, directoryChecked = false;
    try {
    active();
    if (++entries > entryLimit) throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'ENTRY_LIMIT' });
    phase('entry');
    const stat = await lstat(path, { bigint: true });
    if (stat.isSymbolicLink()) {
      phase('link');
      await assertInternalLink(paths.slotRoot, path, active);
      if (!sameIdentity(stat, await lstat(path, { bigint: true }))) throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'LINK_REPLACED' });
      bytes += Number(stat.size);
    } else if (stat.isDirectory()) {
      directoryBefore = stat;
      phase('directory-open');
      // 已访问与所有祖先尚待处理的名称共用原条目上限，不能为关闭句柄引入无界快照。
      const children = await readManagedDirectoryNames(path, entryLimit - entries - pendingEntries, signal, progress, reserveEntry);
      for (const [index, child] of children.entries()) {
        active(); pendingEntries--;
        // 不等待分支许可；没有空位时沿当前分支前进，避免递归持有许可后互相等待。
        // 文件和目录共用原有分支额度；每项仍重新读取元数据，不复用枚举类型。
        if (availableBranches === 0 || index === children.length - 1) await visit(resolve(path, child));
        else {
          availableBranches--;
          const branch: Promise<void> = visit(resolve(path, child)).catch(error => { fail(error); })
            .finally(() => { availableBranches++; branches.delete(branch); });
          branches.add(branch);
        }
        phase('directory-read');
      }
      await Promise.all(branches);
      // 释放搜索句柄后重新核对目录；不返回已变化子树的部分计数。
      active(); await assertDirectoryIdentity(paths, path, stat); directoryChecked = true;
    } else if (stat.isFile()) bytes += Number(stat.size);
    else throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'FILE_TYPE' });
    if (!Number.isSafeInteger(bytes)) throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'SIZE_OVERFLOW' });
    } catch (error) { throw fail(error, path); }
    finally {
      await Promise.all(branches);
      // 可重试首错不能省略在途目录的末尾复核；已知链接或命名空间更换必须阻止重扫。
      if (directoryBefore && !directoryChecked && failed && !rescanBlockedBy && !signal?.aborted && canRescanUsage(failure)) {
        try { await assertDirectoryIdentity(paths, path, directoryBefore); }
        catch (error) { fail(error, path, 'directory-validation'); }
      }
    }
  };
  try {
    const assertRoot = async () => {
      if (!sameIdentity(await fileIdentity(paths.sourceRoot), paths.sourceIdentity) || await realpath(paths.sourceRoot) !== paths.sourceRoot
        || !sameIdentity(await fileIdentity(paths.slotRoot), paths.slotIdentity) || await realpath(paths.slotRoot) !== paths.slotRoot) throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'ROOT_REPLACED' });
    };
    phase('root'); await assertRoot();
    await visit(paths.slotRoot);
    phase('anchor');
    if (await pathExists(paths.anchorPath)) {
      const stat = await lstat(paths.anchorPath);
      if (!stat.isFile()) throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'ANCHOR_TYPE' });
      bytes += stat.size;
    }
    phase('volume'); const volume = await statfs(paths.slotRoot, { bigint: true });
    phase('root'); await assertRoot();
    active();
    const available = volume.bavail * volume.bsize;
    if (available < 0n || available > BigInt(Number.MAX_SAFE_INTEGER)) throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'VOLUME_SIZE' });
    phase('complete'); return { bytes, freeBytes: Number(available) };
  } catch (error) {
    const observed = error instanceof ReleaseError ? error : new ReleaseError('BUDGET_UNKNOWN', { reason: 'IO_OBSERVATION', ioCode: record(error).code,
      entry: typeof record(error).path === 'string' ? relative(paths.slotRoot, String(record(error).path)) : undefined });
    if (rescanBlockedBy && canRescanUsage(observed)) {
      const blocked = new ReleaseError(observed.code, { ...observed.details, rescanBlockedBy });
      progress?.failureWitness?.selected(error, blocked, paths); throw blocked;
    }
    progress?.failureWitness?.selected(error, observed, paths);
    throw observed;
  }
}
export async function measureManagedUsage(paths: ManagedPaths, signal?: AbortSignal, scan = measureManagedUsageOnce, progress?: ManagedUsageProgress): Promise<{ bytes: number; freeBytes: number }> {
  const active = () => { if (signal?.aborted) throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'OBSERVATION_DEADLINE' }); };
  active();
  const checkout = await lstat(paths.checkoutRoot, { bigint: true }).catch((error: unknown) => {
    if (record(error).code === 'ENOENT') return undefined;
    throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'IO_OBSERVATION', ioCode: record(error).code, entry: 'checkout' });
  });
  const assertCheckout = async () => {
    active();
    if (!checkout) return;
    try { await assertDirectoryIdentity(paths, paths.checkoutRoot, checkout); active(); }
    catch (error) {
      if (error instanceof ReleaseError) throw error;
      throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'CHECKOUT_UNCONFIRMED', ioCode: record(error).code, entry: 'checkout' });
    }
  };
  for (let attempt = 0; ; attempt++) {
    try { const value = await scan(paths, signal, progress); await assertCheckout(); return value; }
    catch (error) {
      // 普通子树变化只能丢弃整扫；根、链接与命名空间变化不能借重扫重新绑定。
      if (attempt >= 2 || !(error instanceof ReleaseError) || !canRescanUsage(error)
        || error.details.reason === 'DIRECTORY_REPLACED' && !checkout) throw error;
      await assertCheckout();
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
