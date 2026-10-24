import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { acquireRetirementLease } from '../src/node/retirement-lease.js';
import { fileIdentity } from '../src/node/managed-io.js';
import { readRetirementHost } from '../src/node/retirement-host.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const fixture = async () => {
  const base = resolve(import.meta.dirname, '../../../.tmp/retirement-lease-tests');
  await mkdir(base, { recursive: true }); const slotRoot = await mkdtemp(resolve(base, 'l-')); roots.push(slotRoot);
  return { paths: { slotRoot, slotIdentity: await fileIdentity(slotRoot) }, host: await readRetirementHost() };
};
it('excludes another lease and permits reuse after release', async () => {
  const f = await fixture(), lease = await acquireRetirementLease(f.paths, f.host);
  try { await expect(acquireRetirementLease(f.paths, f.host)).rejects.toMatchObject({ code: 'LOCKED' }); }
  finally { await lease.release(); }
  await (await acquireRetirementLease(f.paths, f.host)).release();
});
it('the OS releases the lease when its real owning process crashes', async () => {
  const f = await fixture();
  const child = spawn(process.execPath, [resolve(import.meta.dirname, 'helpers/retirement-lease-worker.mjs')], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr?.on('data', chunk => { stderr += String(chunk); });
  const closed = once(child, 'close');
  try {
    const ready = once(child, 'message'); child.send(f);
    const outcome = await Promise.race([ready.then(([message]) => message), closed.then(() => ({ error: stderr }))]);
    expect(outcome).toEqual({ ready: true });
    await expect(acquireRetirementLease(f.paths, f.host)).rejects.toMatchObject({ code: 'LOCKED' });
    expect(child.kill('SIGKILL')).toBe(true); await closed;
    expect(child.signalCode).toBe('SIGKILL');
    await (await acquireRetirementLease(f.paths, f.host)).release();
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; }
});
it('rejects replacement of the owned directory before taking a lease', async () => {
  const f = await fixture();
  await expect(acquireRetirementLease({ ...f.paths, slotIdentity: { dev: '0', ino: '0' } }, f.host)).rejects.toMatchObject({ code: 'SLOT_PATH' });
});
