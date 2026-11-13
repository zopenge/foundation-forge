import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { managedPhaseSession } from './helpers/managed-phase-session.js';

it('keeps late session ownership checks and release bound to their original lock generation', async () => {
  const value = await managedPhaseSession();
  try {
    const previous = await value.next('publish');
    const current = await value.next('verify');
    const before = await readFile(current.slot.paths.lockPath);
    expect(JSON.parse(before.toString('utf8')).runId).toBe(current.slot.runId);
    await expect(previous.slot.lock.assertOwned()).rejects.toMatchObject({ code: 'LOCK_OWNERSHIP' });
    await expect(previous.slot.assertMetadataOwned()).rejects.toMatchObject({ code: 'LOCK_OWNERSHIP' });
    await expect(previous.persist()).rejects.toMatchObject({ code: 'LOCK_OWNERSHIP' });
    await previous.slot.lock.release();
    expect(await readFile(current.slot.paths.lockPath)).toEqual(before);
    await expect(current.slot.lock.assertOwned()).resolves.toBeUndefined();
    await current.persist();
    expect(JSON.parse(await readFile(current.slot.paths.statePath, 'utf8')).runId).toBe(current.slot.runId);
  } finally { await value.dispose(); }
});
