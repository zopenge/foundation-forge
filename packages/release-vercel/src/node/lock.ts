import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ReleaseError } from './errors.js';

export interface OwnedLock {
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}
export async function acquireLock(path: string, metadata?: { readonly runId: string; readonly identity: { readonly pid: number; readonly startToken: string } }): Promise<OwnedLock> {
  await mkdir(dirname(path), { recursive: true });
  const owner = JSON.stringify({ pid: process.pid, token: randomUUID(), startedAt: new Date().toISOString(), ...metadata });
  let handle;
  try { handle = await open(path, 'wx'); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') throw new ReleaseError('LOCKED', { path });
    throw error;
  }
  try { await handle.writeFile(owner, 'utf8'); }
  catch (error) { await handle.close(); await unlink(path); throw error; }
  await handle.close();
  const assertOwned = async () => {
    if (await readFile(path, 'utf8') !== owner) throw new ReleaseError('LOCK_OWNERSHIP', { path });
  };
  return { assertOwned, release: async () => { await assertOwned(); await unlink(path); } };
}
