import { randomUUID } from 'node:crypto';
import { link, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ManagedPaths, ManagedState } from './release-context.js';
import { assertPathChain, fileIdentity, readBoundedJson, sameIdentity } from './managed-io.js';
import { currentCoordinator } from './process-identities.js';
import { record, ReleaseError } from './errors.js';
import { retirementDigest, writeRetirementJson } from './retirement-record.js';
import type { RetirementLease } from './retirement-lease.js';

/** 调用方必须先持有原生 retirement lease；仅此协议的死亡声明可在该锁内接管。 */
export async function claimRetirement(paths: ManagedPaths, state: ManagedState, snapshotSha256: string, lease: RetirementLease, guard: () => Promise<void>, signal?: AbortSignal) {
  await lease.assertOwned();
  await assertPathChain(paths.slotRoot, paths.recoveryLockPath);
  const previous = await readBoundedJson(paths.recoveryLockPath, 65_536);
  if (previous !== undefined) {
    const item = record(previous), identity = record(item.identity), before = await fileIdentity(paths.recoveryLockPath);
    if (item.schemaVersion !== 1 || item.kind !== 'retirement-claim' || item.runId !== state.runId || item.slotId !== state.slotId
      || item.snapshotSha256 !== snapshotSha256 || typeof item.token !== 'string' || !/^[a-f0-9-]{36}$/u.test(item.token)
      || !Number.isSafeInteger(identity.pid) || typeof identity.startToken !== 'string') throw new ReleaseError('LOCKED', { reason: 'FOREIGN_RECOVERY_CLAIM' });
    // 旧声明只保护本协议的元数据事务。原生 lease 已排除活动事务，不依赖长寿命 API 宿主的 PID 消失。
    await lease.assertOwned(); await guard();
    if (!sameIdentity(before, await fileIdentity(paths.recoveryLockPath)) || retirementDigest(await readBoundedJson(paths.recoveryLockPath)) !== retirementDigest(previous)) throw new ReleaseError('LOCK_OWNERSHIP');
    await unlink(paths.recoveryLockPath);
  }
  const value = { schemaVersion: 1, kind: 'retirement-claim', runId: state.runId, slotId: state.slotId, snapshotSha256,
    token: randomUUID(), identity: await currentCoordinator(signal) };
  const staged = resolve(paths.slotRoot, 'retirement-work/claim.json');
  await writeRetirementJson(staged, value, paths, state, guard);
  try { await link(staged, paths.recoveryLockPath); }
  catch (error) { if (record(error).code === 'EEXIST') throw new ReleaseError('LOCKED'); throw error; }
  const identity = await fileIdentity(paths.recoveryLockPath);
  const assertOwned = async () => {
    await lease.assertOwned();
    await assertPathChain(paths.slotRoot, paths.recoveryLockPath);
    if (!sameIdentity(identity, await fileIdentity(paths.recoveryLockPath)) || retirementDigest(await readBoundedJson(paths.recoveryLockPath)) !== retirementDigest(value)) throw new ReleaseError('LOCK_OWNERSHIP');
  };
  return { assertOwned, release: async () => { await assertOwned(); await unlink(paths.recoveryLockPath); } };
}
