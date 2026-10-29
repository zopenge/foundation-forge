import { unlink } from 'node:fs/promises';
import type { ManagedPaths, ManagedState } from './release-context.js';
import type { OwnedLock } from './lock.js';
import { record, ReleaseError } from './errors.js';
import { assertManagedPaths, assertManagementUntracked } from './managed-paths.js';
import { fileIdentity, measureManagedUsage, pathExists, readBoundedJson, sameIdentity } from './managed-io.js';
import { parseManagedState } from './managed-state.js';
import { createManagedExecution } from './managed-execution.js';
import { hasManagedDisposition } from './managed-disposition.js';
import { acquireRetirementLease } from './retirement-lease.js';
import { readRetirementHost } from './retirement-host.js';
import { claimRetirement } from './retirement-claim.js';
import { retirementDigest } from './retirement-record.js';
import { assertMetadataFile, inspectMetadataFile } from './managed-metadata.js';
import { assertManagedHistory } from './managed-history.js';

export async function claimManagedRecovery(paths: ManagedPaths, state: ManagedState, signal?: AbortSignal): Promise<{ readonly claim: OwnedLock; readonly oldLock?: OwnedLock }> {
  await assertManagedPaths(paths);
  const management = createManagedExecution(state.source.root, state.source.config, undefined, []);
  await assertManagementUntracked(state.source, management);
  const config = state.source.config.source;
  if (config.mode !== 'managed-commit') throw new ReleaseError('SOURCE_UNSUPPORTED');
  const usage = await measureManagedUsage(paths);
  if (usage.bytes + 1024 > config.maxBytes || usage.freeBytes - 1024 < config.minFreeBytes) throw new ReleaseError('BUDGET_EXCEEDED', { reason: 'RECOVERY_ADMISSION' });
  await assertManagedHistory(paths, state);
  const stateFile = await inspectMetadataFile(paths.statePath);
  const lease = await acquireRetirementLease(paths, await readRetirementHost(signal), signal);
  const guard = async () => { await lease.assertOwned(); await assertManagedPaths(paths); await assertManagementUntracked(state.source, management); await assertMetadataFile(paths.statePath, stateFile); };
  let rawClaim: OwnedLock;
  try { rawClaim = await claimRetirement(paths, state, retirementDigest({ runId: state.runId, slotId: state.slotId, stateFile }), lease, guard, signal, 'managed-recovery-claim'); }
  catch (error) { await lease.release(); throw error; }
  const assertClaim = async () => { await assertManagedPaths(paths); await assertManagementUntracked(state.source, management); await rawClaim.assertOwned(); };
  const claim = { assertOwned: assertClaim, release: async () => { try { await assertClaim(); await rawClaim.release(); } finally { await lease.release(); } } };
  try {
    const current = parseManagedState(await readBoundedJson(paths.statePath), state.source, state.slotId);
    if (JSON.stringify(current) !== JSON.stringify(state)) throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'RUN_CHANGED' });
    if (!await pathExists(paths.lockPath)) {
      if (state.status !== 'closed' && !await hasManagedDisposition(paths, state)) throw new ReleaseError('LOCK_OWNERSHIP', { reason: 'RUN_LOCK_MISSING' });
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
