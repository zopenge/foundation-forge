import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { claimManagedRecovery } from '../src/node/managed-recovery-lock.js';
import { freezeManagedSource } from '../src/node/source.js';
import { openManagedSlot } from '../src/node/managed-paths.js';
import { createManagedSession } from '../src/node/managed-process.js';
import { managedFixture } from './helpers/managed-fixture.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';

const fixtures: Awaited<ReturnType<typeof managedFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.dispose(); });
const fixture = async () => {
  const f = await managedFixture(); fixtures.push(f);
  const source = await freezeManagedSource(f.cwd, 'release.config.json', f.execution), slot = await openManagedSlot(source, f.execution);
  const session = await createManagedSession(slot, 'check'); return { ...f, slot, session };
};
it('uses an independent recovery claim so two recovery callers cannot release one run', async () => {
  const f = await fixture(), recovery = await claimManagedRecovery(f.slot.paths, f.session.state);
  await expect(claimManagedRecovery(f.slot.paths, f.session.state)).rejects.toMatchObject({ code: 'LOCKED' });
  await recovery.oldLock?.assertOwned(); await recovery.claim.release(); await f.slot.lock.release();
});
it('does not remove a replaced run lock during explicit recovery', async () => {
  const f = await fixture(), recovery = await claimManagedRecovery(f.slot.paths, f.session.state);
  await writeFile(f.slot.paths.lockPath, 'different owner');
  await expect(recovery.oldLock?.release()).rejects.toMatchObject({ code: 'LOCK_OWNERSHIP' });
  expect(await readFile(f.slot.paths.lockPath, 'utf8')).toBe('different owner'); await recovery.claim.release();
});
it('resumes its own recovery metadata claim after a real recovery coordinator crash', async () => {
  const f = await fixture(), source = f.slot.source;
  await f.slot.store.writeAnchor({ schemaVersion: 2, slotId: f.slot.slotId, slotPath: f.slot.paths.slotRoot, sourceRoot: source.root, configPath: source.configPath });
  const before = await readFile(f.slot.paths.statePath);
  const child = spawn(process.execPath, [resolve(import.meta.dirname, 'helpers/retirement-claim-worker.mjs')], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr?.on('data', chunk => { stderr += String(chunk); }); const closed = once(child, 'close');
  try {
    const ready = once(child, 'message'); child.send({ cwd: f.cwd, mode: 'recover' });
    expect(await Promise.race([ready.then(([value]) => value), closed.then(() => ({ error: stderr }))])).toEqual({ ready: true });
    expect(child.kill('SIGKILL')).toBe(true); await closed;
    const recovered = await claimManagedRecovery(f.slot.paths, f.session.state);
    await recovered.oldLock?.assertOwned(); await recovered.claim.release();
    expect(await readFile(f.slot.paths.statePath)).toEqual(before);
    await f.slot.lock.release();
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; }
});
