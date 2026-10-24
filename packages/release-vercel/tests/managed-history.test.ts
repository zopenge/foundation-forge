import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { git, managedFixture } from './helpers/managed-fixture.js';
import { freezeManagedSource } from '../src/node/source.js';
import { openManagedSlot } from '../src/node/managed-paths.js';
import { createManagedSession } from '../src/node/managed-process.js';
import { archiveManagedDisposition, dispositionPath } from '../src/node/managed-disposition.js';
import { assertManagedRemoteSettled } from '../src/node/managed-remote-state.js';
import { randomUUID } from 'node:crypto';

const fixtures: Awaited<ReturnType<typeof managedFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.dispose(); });
async function fixture() {
  const f = await managedFixture(); fixtures.push(f);
  const source = await freezeManagedSource(f.cwd, 'release.config.json', f.execution);
  const old = await openManagedSlot(source, f.execution);
  await old.store.writeAnchor({ schemaVersion: 2, slotId: old.slotId, slotPath: old.paths.slotRoot, sourceRoot: source.root, configPath: source.configPath });
  const session = await createManagedSession(old, 'publish');
  session.state.status = 'closed'; session.state.effects.developmentPush = 'unknown'; session.state.pendingPush = 'developmentPush';
  await session.persist(); await archiveManagedDisposition(old.paths, session.state, session.state, () => old.lock.assertOwned());
  await old.lock.release(); git(f.cwd, 'push', 'origin', `${source.sha}:dev`);
  const current = await openManagedSlot(source, f.execution), next = await createManagedSession(current, 'check');
  return { ...f, source, old, current, next, history: dispositionPath(old.paths, old.runId) };
}
it.each(['missing', 'same-bytes-replaced'])('does not forget an old remote intent when its history is %s', async mode => {
  const f = await fixture();
  await expect(assertManagedRemoteSettled(f.current.paths, f.execution)).resolves.toBeUndefined();
  const bytes = await readFile(f.history); await rename(f.history, resolve(f.root, 'original-history.json'));
  if (mode === 'same-bytes-replaced') await writeFile(f.history, bytes);
  await expect(assertManagedRemoteSettled(f.current.paths, f.execution)).rejects.toMatchObject({ code: 'SLOT_STATE' });
  await f.current.lock.release();
});
it('blocks the next local admission when prior history was removed after a completed check', async () => {
  const f = await fixture(); f.next.state.status = 'closed'; await f.next.persist(); await f.current.lock.release();
  await rename(f.history, resolve(f.root, 'original-history.json'));
  await expect(openManagedSlot(f.source, f.execution)).rejects.toMatchObject({ code: 'SLOT_STATE' });
});
it('never authorizes release by dropping an incomplete command from the historical state', async () => {
  const f = await fixture();
  f.next.state.processes.push({ id: randomUUID(), name: 'unresolved-command', status: 'intent', observationComplete: false, descendants: [] });
  await f.next.persist();
  await expect(archiveManagedDisposition(f.current.paths, f.next.state, { ...f.next.state, processes: [] }, () => f.current.lock.assertOwned()))
    .rejects.toMatchObject({ code: 'SLOT_STATE', details: { reason: 'HISTORY_STOP' } });
  await f.current.lock.release();
});
