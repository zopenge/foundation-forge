import { mkdir, mkdtemp, realpath, rename, rm, symlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { acquireLocalDirectoryLease, type LocalDirectoryLease, type LocalDirectoryLeaseOptions } from '../src/index.js';
import { ensureTestTemporaryDirectory } from '../../../scripts/test-temporary-directory.mjs';

const native = it.runIf(process.arch === 'x64' && ['win32', 'linux'].includes(process.platform));
const options: LocalDirectoryLeaseOptions = { scope: { namespace: 'FoundationForge.TestLease', discriminator: 'fixture' } };
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = resolve(import.meta.dirname, '../../..');
  const base = await ensureTestTemporaryDirectory(root, resolve(process.env.FORGE_CHECK_JOB_TEMP ?? resolve(root, 'tmp'), 'dir-lease-tests'));
  const owned = await realpath(await mkdtemp(resolve(base, 'l-')));
  roots.push(owned);
  const directory = resolve(owned, 'lock');
  await mkdir(directory);
  return { directory, owned };
}

native('excludes another holder and verifies identity before reuse', async () => {
  const { directory } = await fixture();
  const lease = await acquireLocalDirectoryLease(directory, options);
  try {
    expect(lease.identity).toMatchObject({ dev: expect.stringMatching(/^\d+$/u), ino: expect.stringMatching(/^\d+$/u) });
    await lease.assertOwned();
    await expect(acquireLocalDirectoryLease(directory, options)).rejects.toMatchObject({ code: 'LOCKED' });
  } finally { await Promise.all([lease.release(), lease.release()]); }
  await expect(lease.assertOwned()).rejects.toMatchObject({ code: 'LOCK_OWNERSHIP' });
  await (await acquireLocalDirectoryLease(directory, { ...options, expectedIdentity: lease.identity })).release();
});

it.runIf(process.platform === 'win32' && process.arch === 'x64')('excludes a second copy loaded on the same Windows thread', async () => {
  const { directory } = await fixture();
  const lease = await acquireLocalDirectoryLease(directory, options);
  let another: LocalDirectoryLease | undefined;
  try {
    vi.resetModules();
    const copy = await import('../src/index.js');
    await expect(copy.acquireLocalDirectoryLease(directory, options).then(value => { another = value; return value; }))
      .rejects.toMatchObject({ code: 'LOCKED' });
  } finally { await another?.release(); await lease.release(); }
});

native.each(process.platform === 'win32' ? ['public', 'legacy Windows name'] : ['public'])('excludes a real %s holder until the OS closes it', async mode => {
  const { directory } = await fixture();
  const child = spawn(process.execPath, [resolve(import.meta.dirname, 'fixtures/local-directory-lease-owner.mjs')],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  const closed = new Promise<void>(done => child.once('close', () => done()));
  try {
    let mutexName: string | undefined;
    if (mode === 'legacy Windows name') {
      const probe = await acquireLocalDirectoryLease(directory, options);
      const { dev, ino } = probe.identity;
      await probe.release();
      const digest = createHash('sha256').update(`fixture:${dev}:${ino}`).digest('hex');
      mutexName = `Global\\FoundationForge.TestLease.${digest}`;
    }
    const ready = once(child, 'message', { signal: AbortSignal.timeout(5000) });
    child.send({ directory, options, mutexName });
    const outcome = await Promise.race([ready.then(([message]) => message), closed.then(() => ({ error: stderr }))]);
    expect(outcome).toEqual({ ready: true });
    await expect(acquireLocalDirectoryLease(directory, options)).rejects.toMatchObject({ code: 'LOCKED' });
    expect(child.kill('SIGKILL')).toBe(true);
    await closed;
    expect(child.signalCode).toBe('SIGKILL');
    await (await acquireLocalDirectoryLease(directory, options)).release();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
}, 12_000);

native('rejects noncanonical paths, links, stale identities and cancellation', async () => {
  const { directory, owned } = await fixture();
  const alias = resolve(owned, 'alias');
  await symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(acquireLocalDirectoryLease('relative', options)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(acquireLocalDirectoryLease(alias, options)).rejects.toMatchObject({ code: 'DIRECTORY_CHANGED' });
  await expect(acquireLocalDirectoryLease(directory, { ...options, expectedIdentity: { dev: '0', ino: '0' } })).rejects.toMatchObject({ code: 'DIRECTORY_CHANGED' });
  await expect(acquireLocalDirectoryLease(directory, { ...options, expectedIdentity: { dev: 'x', ino: '0' } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(acquireLocalDirectoryLease(directory, { ...options, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'CANCELLED' });
  const lease = await acquireLocalDirectoryLease(directory, options);
  try {
    await rename(directory, resolve(owned, 'moved'));
    await mkdir(directory);
    await expect(lease.assertOwned()).rejects.toMatchObject({ code: 'DIRECTORY_CHANGED' });
    await expect(acquireLocalDirectoryLease(directory, { ...options, expectedIdentity: lease.identity })).rejects.toMatchObject({ code: 'DIRECTORY_CHANGED' });
  } finally { await lease.release(); }
});
