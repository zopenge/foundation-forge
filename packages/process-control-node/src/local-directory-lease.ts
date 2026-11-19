import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import process from 'node:process';
import { loadOwnedNative } from './owned-scope/native-loader.js';

export interface LocalDirectoryIdentity { readonly dev: string; readonly ino: string }
export interface LocalDirectoryLeaseScope { readonly namespace: string; readonly discriminator?: string }
export interface LocalDirectoryLeaseOptions {
  readonly scope: LocalDirectoryLeaseScope;
  readonly expectedIdentity?: LocalDirectoryIdentity;
  readonly signal?: AbortSignal | undefined;
}
export interface LocalDirectoryLease {
  readonly identity: LocalDirectoryIdentity;
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}
export type LocalDirectoryLeaseErrorCode = 'INVALID_INPUT' | 'DIRECTORY_CHANGED' | 'LOCKED' | 'LOCK_OWNERSHIP' | 'UNSUPPORTED' | 'IO_FAILED' | 'CANCELLED';
export class LocalDirectoryLeaseError extends Error {
  constructor(readonly code: LocalDirectoryLeaseErrorCode, readonly reason: string, cause?: unknown) {
    super(code, { cause });
    this.name = 'LocalDirectoryLeaseError';
  }
}

const reservationKey = Symbol.for('@openge/forge-process-control-node/local-directory-lease');
// Windows mutex 可被同一线程递归取得。将占用表绑定到当前 Node 实例，覆盖重复加载的模块。
function reservations(): Set<string> {
  const owner = process as typeof process & { [reservationKey]?: Set<string> };
  return owner[reservationKey] ??= new Set<string>();
}
const active = (signal?: AbortSignal) => { if (signal?.aborted) throw new LocalDirectoryLeaseError('CANCELLED', 'ABORTED'); };
const identityOf = (stat: { dev: bigint; ino: bigint }): LocalDirectoryIdentity => ({ dev: stat.dev.toString(), ino: stat.ino.toString() });
const sameIdentity = (a: LocalDirectoryIdentity, b: LocalDirectoryIdentity) => a.dev === b.dev && a.ino === b.ino;
type Native = Awaited<ReturnType<typeof loadOwnedNative>>;
type ReleaseNative = () => Promise<void>;

async function readIdentity(directory: string): Promise<LocalDirectoryIdentity> {
  try {
    const before = await lstat(directory, { bigint: true });
    if (before.isDirectory() && await realpath(directory) === directory) {
      const after = await lstat(directory, { bigint: true });
      if (after.isDirectory() && sameIdentity(identityOf(before), identityOf(after))) return identityOf(after);
    }
  } catch (error) { throw new LocalDirectoryLeaseError('DIRECTORY_CHANGED', 'ROOT', error); }
  throw new LocalDirectoryLeaseError('DIRECTORY_CHANGED', 'ROOT');
}

function acquireWindows(k: Native, name: string): ReleaseNative {
  const lib = k.load('kernel32.dll');
  const create = lib.func('void * __stdcall CreateMutexW(void *attributes, int32_t owner, str16 name)');
  const wait = lib.func('uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t milliseconds)');
  const unlock = lib.func('int32_t __stdcall ReleaseMutex(void *handle)');
  const close = lib.func('int32_t __stdcall CloseHandle(void *handle)');
  const handle: bigint | null = create(null, 0, name);
  if (!handle) throw new LocalDirectoryLeaseError('UNSUPPORTED', 'MUTEX');
  const status = Number(wait(handle, 0));
  if (status !== 0 && status !== 128) {
    if (!close(handle)) throw new LocalDirectoryLeaseError('IO_FAILED', 'MUTEX_CLOSE');
    throw new LocalDirectoryLeaseError(status === 258 ? 'LOCKED' : 'IO_FAILED', 'MUTEX_WAIT');
  }
  return async () => {
    const released = unlock(handle), closed = close(handle);
    if (!released || !closed) throw new LocalDirectoryLeaseError('IO_FAILED', 'MUTEX_RELEASE');
  };
}

async function acquireLinux(k: Native, path: string, identity: LocalDirectoryIdentity, signal?: AbortSignal): Promise<ReleaseNative> {
  const lib = k.load('libc.so.6'), flock = lib.func('int flock(int fd, int operation)');
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch((error: unknown) => {
    active(signal);
    if (error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(String(error.code))) {
      throw new LocalDirectoryLeaseError('DIRECTORY_CHANGED', 'ROOT', error);
    }
    throw error;
  });
  try {
    const stat = await directory.stat({ bigint: true });
    active(signal);
    if (!stat.isDirectory() || !sameIdentity(identityOf(stat), identity)) throw new LocalDirectoryLeaseError('DIRECTORY_CHANGED', 'ROOT');
    if (Number(flock(directory.fd, 2 | 4)) !== 0) throw new LocalDirectoryLeaseError(k.errno() === 11 ? 'LOCKED' : 'IO_FAILED', 'FLOCK');
  } catch (error) { await directory.close(); throw error; }
  // 目录描述符由本次持锁独占，关闭即释放 flock。
  return () => directory.close();
}

/** 锁只约束本机持有者。调用方独立验证子进程停止及远端写入者状态。 */
export async function acquireLocalDirectoryLease(directory: string, options: LocalDirectoryLeaseOptions): Promise<LocalDirectoryLease> {
  const signal = options?.signal;
  const namespace = options?.scope?.namespace, discriminator = options?.scope?.discriminator;
  active(signal);
  if (typeof directory !== 'string' || !isAbsolute(directory)
    || typeof namespace !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/u.test(namespace)
    || (discriminator !== undefined && (typeof discriminator !== 'string' || !/^[a-zA-Z0-9_.-]{0,128}$/u.test(discriminator)))) {
    throw new LocalDirectoryLeaseError('INVALID_INPUT', 'ARGUMENT');
  }
  const expected = options.expectedIdentity;
  const expectedIdentity = expected === undefined ? undefined : { dev: expected?.dev, ino: expected?.ino };
  const decimal = /^\d+$/u;
  if (expectedIdentity && (typeof expectedIdentity.dev !== 'string' || !decimal.test(expectedIdentity.dev)
    || typeof expectedIdentity.ino !== 'string' || !decimal.test(expectedIdentity.ino))) throw new LocalDirectoryLeaseError('INVALID_INPUT', 'IDENTITY');
  const platform = process.platform;
  if ((platform !== 'win32' && platform !== 'linux') || process.arch !== 'x64') throw new LocalDirectoryLeaseError('UNSUPPORTED', 'NATIVE_HOST');
  const identity = Object.freeze(await readIdentity(directory));
  active(signal);
  if (expectedIdentity && !sameIdentity(identity, expectedIdentity)) throw new LocalDirectoryLeaseError('DIRECTORY_CHANGED', 'ROOT');
  const guard = async () => {
    if (!sameIdentity(identity, await readIdentity(directory))) throw new LocalDirectoryLeaseError('DIRECTORY_CHANGED', 'ROOT');
  };
  const key = createHash('sha256').update(`${discriminator ?? ''}:${identity.dev}:${identity.ino}`).digest('hex');
  const name = `Global\\${namespace}.${key}`;
  const reservation = platform === 'win32' ? name : `${identity.dev}:${identity.ino}`;
  const activeLeases = reservations();
  if (activeLeases.has(reservation)) throw new LocalDirectoryLeaseError('LOCKED', 'ACTIVE');
  activeLeases.add(reservation);
  let releaseNative: ReleaseNative | undefined;
  const releaseHeld = async () => {
    try { await releaseNative?.(); }
    catch (error) {
      if (error instanceof LocalDirectoryLeaseError) throw error;
      throw new LocalDirectoryLeaseError('IO_FAILED', 'NATIVE_RELEASE', error);
    }
    activeLeases.delete(reservation);
  };
  try {
    const native = await loadOwnedNative(platform).catch((error: unknown) => { throw new LocalDirectoryLeaseError('UNSUPPORTED', 'NATIVE_UNAVAILABLE', error); });
    active(signal);
    releaseNative = platform === 'win32' ? acquireWindows(native, name) : await acquireLinux(native, directory, identity, signal);
    await guard(); active(signal);
    let releasing: Promise<void> | undefined;
    const assertHeld = () => { if (releasing) throw new LocalDirectoryLeaseError('LOCK_OWNERSHIP', 'RELEASED'); };
    return { identity, assertOwned: async () => { assertHeld(); await guard(); assertHeld(); },
      release: () => releasing ??= releaseHeld() };
  } catch (error) {
    await releaseHeld();
    if (error instanceof LocalDirectoryLeaseError) throw error;
    throw new LocalDirectoryLeaseError('IO_FAILED', 'NATIVE_CALL', error);
  }
}
