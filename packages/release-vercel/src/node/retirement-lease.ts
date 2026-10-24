import type { ManagedPaths } from './release-context.js';
import type { RetirementHost } from './retirement-host.js';
import { createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { assertActive, ReleaseError } from './errors.js';
import { fileIdentity, sameIdentity } from './managed-io.js';

const activeLeases = new Set<string>();
export interface RetirementLease { assertOwned(): Promise<void>; release(): Promise<void> }
/** OS 锁仅串行化封存元数据事务，不能作为旧命令已关闭的证据。 */
export async function acquireRetirementLease(paths: Pick<ManagedPaths, 'slotRoot' | 'slotIdentity'>, host: RetirementHost, signal?: AbortSignal): Promise<RetirementLease> {
  assertActive(signal);
  const guard = async () => {
    if (await realpath(paths.slotRoot) !== paths.slotRoot || !sameIdentity(await fileIdentity(paths.slotRoot), paths.slotIdentity)) throw new ReleaseError('SLOT_PATH', { reason: 'RETIREMENT_ROOT' });
  };
  await guard();
  if (process.platform !== host.platform || process.arch !== 'x64') throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'RETIREMENT_NATIVE_HOST' });
  const key = createHash('sha256').update(`${host.hostId}:${paths.slotIdentity.dev}:${paths.slotIdentity.ino}`).digest('hex');
  if (activeLeases.has(key)) throw new ReleaseError('LOCKED', { reason: 'RETIREMENT_ACTIVE' });
  activeLeases.add(key);
  let releaseNative: (() => Promise<void>) | undefined;
  try {
    const k = (await import('koffi')).default;
    if (k.version !== '3.3.3') throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'RETIREMENT_NATIVE_VERSION' });
    if (host.platform === 'win32') {
      const lib = k.load('kernel32.dll');
      const create = lib.func('void * __stdcall CreateMutexW(void *attributes, int32_t owner, str16 name)');
      const wait = lib.func('uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t milliseconds)');
      const unlock = lib.func('int32_t __stdcall ReleaseMutex(void *handle)');
      const close = lib.func('int32_t __stdcall CloseHandle(void *handle)');
      const handle: bigint | null = create(null, 0, `Global\\FoundationForge.Retirement.${key}`);
      if (!handle) throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'RETIREMENT_MUTEX' });
      const status = Number(wait(handle, 0));
      if (status !== 0 && status !== 128) { close(handle); throw new ReleaseError(status === 258 ? 'LOCKED' : 'IO_FAILED', { reason: 'RETIREMENT_MUTEX_WAIT' }); }
      releaseNative = async () => {
        const released = unlock(handle), closed = close(handle);
        if (!released || !closed) throw new ReleaseError('IO_FAILED', { reason: 'RETIREMENT_MUTEX_RELEASE' });
      };
    } else {
      const lib = k.load('libc.so.6'), flock = lib.func('int flock(int fd, int operation)');
      const directory = await open(paths.slotRoot, 'r');
      if (Number(flock(directory.fd, 2 | 4)) !== 0) { await directory.close(); throw new ReleaseError('LOCKED', { reason: 'RETIREMENT_FLOCK' }); }
      releaseNative = async () => { try { if (Number(flock(directory.fd, 8)) !== 0) throw new ReleaseError('IO_FAILED', { reason: 'RETIREMENT_FLOCK_RELEASE' }); } finally { await directory.close(); } };
    }
    await guard(); assertActive(signal);
    let released = false;
    return { assertOwned: async () => { if (released || !activeLeases.has(key)) throw new ReleaseError('LOCK_OWNERSHIP'); await guard(); }, release: async () => {
      if (released) return; released = true;
      try { await releaseNative?.(); } finally { activeLeases.delete(key); }
    } };
  } catch (error) {
    try { await releaseNative?.(); } finally { activeLeases.delete(key); }
    if (error instanceof ReleaseError) throw error;
    throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'RETIREMENT_NATIVE_UNAVAILABLE' });
  }
}
