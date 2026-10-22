import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import type { ManagedPaths, ManagedState } from './release-context.js';
import { acquireLock, type OwnedLock } from './lock.js';
import { record, ReleaseError } from './errors.js';
import { assertManagedPaths, assertManagementUntracked } from './managed-paths.js';
import { fileIdentity, measureManagedUsage, pathExists, readBoundedJson, sameIdentity } from './managed-io.js';
import { currentCoordinator } from './process-identities.js';
import { parseManagedState } from './managed-state.js';
import { Execution } from './execution.js';

export async function claimManagedRecovery(paths: ManagedPaths, state: ManagedState, signal?: AbortSignal): Promise<{ readonly claim: OwnedLock; readonly oldLock?: OwnedLock }> {
  await assertManagedPaths(paths);
  const management = new Execution(state.source.root, state.source.config, signal, []);
  await assertManagementUntracked(state.source, management);
  const config = state.source.config.source;
  if (config.mode !== 'managed-commit') throw new ReleaseError('SOURCE_UNSUPPORTED');
  const usage = await measureManagedUsage(paths);
  if (usage.bytes + 1024 > config.maxBytes || usage.freeBytes - 1024 < config.minFreeBytes) throw new ReleaseError('BUDGET_EXCEEDED', { reason: 'RECOVERY_ADMISSION' });
  const coordinator = await currentCoordinator(signal), rawClaim = await acquireLock(paths.recoveryLockPath, { runId: randomUUID(), identity: coordinator });
  const assertClaim = async () => { await assertManagedPaths(paths); await assertManagementUntracked(state.source, management); await rawClaim.assertOwned(); };
  const claim = { assertOwned: assertClaim, release: async () => { await assertClaim(); await rawClaim.release(); } };
  try {
    const current = parseManagedState(await readBoundedJson(paths.statePath), state.source, state.slotId);
    if (JSON.stringify(current) !== JSON.stringify(state)) throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'RUN_CHANGED' });
    if (!await pathExists(paths.lockPath)) {
      if (state.status !== 'closed' || state.pendingPush || Object.values(state.effects).includes('unknown')) throw new ReleaseError('LOCK_OWNERSHIP', { reason: 'RUN_LOCK_MISSING' });
      return { claim };
    }
    const before = await fileIdentity(paths.lockPath), value = record(await readBoundedJson(paths.lockPath, 65_536));
    const identity = record(value.identity), expected = JSON.stringify(value);
    if (value.pid !== state.coordinator.pid || value.runId !== state.runId || identity.pid !== state.coordinator.pid || identity.startToken !== state.coordinator.startToken
      || typeof value.token !== 'string' || !/^[a-f0-9-]{36}$/u.test(value.token)) throw new ReleaseError('LOCK_OWNERSHIP', { reason: 'RUN_LOCK_BINDING' });
    const assertOwned = async () => {
      await assertManagedPaths(paths); await claim.assertOwned();
      try {
        if (!sameIdentity(await fileIdentity(paths.lockPath), before) || JSON.stringify(await readBoundedJson(paths.lockPath, 65_536)) !== expected) throw new ReleaseError('LOCK_OWNERSHIP');
      } catch { throw new ReleaseError('LOCK_OWNERSHIP', { reason: 'RUN_LOCK_REPLACED_OR_UNREADABLE' }); }
    };
    await assertOwned();
    return { claim, oldLock: { assertOwned, release: async () => { await assertOwned(); await unlink(paths.lockPath); } } };
  } catch (error) {
    try { await claim.release(); }
    catch { throw new ReleaseError('LOCK_OWNERSHIP', { reason: 'RECOVERY_CLAIM_LOST', priorCode: error instanceof ReleaseError ? error.code : 'IO_FAILED' }); }
    throw error;
  }
}
