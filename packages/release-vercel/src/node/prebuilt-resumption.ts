import type { ReleaseTransport } from '../contracts.js';
import type { ManagedReceipt, ManagedSession, ManagedState, PrebuiltEffectResolution } from './release-context.js';
import { ReleaseError } from './errors.js';
import { assertManagedHistory } from './managed-history.js';
import { readManagedDisposition } from './managed-disposition.js';
import { assertPrebuiltEffectObserved, matchesPrebuiltResolution } from './prebuilt-recovery.js';

function pendingAlias(receipt: ManagedReceipt): boolean {
  const alias = receipt.report.prebuilt?.versionAlias;
  return alias?.effect === 'unknown' || (alias?.effect === 'accepted' && !alias.verified);
}
async function originalIntent(session: ManagedSession, receipt: ManagedReceipt): Promise<ManagedState> {
  await assertManagedHistory(session.slot.paths, session.state);
  const id = receipt.report.runId, archive = id ? await readManagedDisposition(session.slot.paths, id) : undefined;
  if (!archive || archive.stopped.source.sha !== receipt.source.sha
    || archive.stopped.source.configSha256 !== receipt.source.configSha256
    || JSON.stringify(archive.stopped.prebuilt) !== JSON.stringify(receipt.report.prebuilt))
    throw new ReleaseError('SLOT_STATE', { reason: 'VERSION_ALIAS_ORIGINAL_INTENT' });
  return archive.stopped;
}

/** 显式verify成功后单独保存原意图的只读证明，不改写publish收据或历史unknown。 */
export async function recordVerifiedAlias(session: ManagedSession, receipt: ManagedReceipt, transport?: ReleaseTransport): Promise<void> {
  if (!pendingAlias(receipt)) return;
  const original = await originalIntent(session, receipt);
  const proof = await assertPrebuiltEffectObserved(original, session.execution, transport);
  if (!proof?.versionAlias?.verified) throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'VERSION_ALIAS_UNRESOLVED' });
  session.state.prebuiltResolutions = [proof]; await session.persist();
}

/** 续发只能消费已封存的成功verify证明；此处不查询云，也不把普通publish变成隐式续验。 */
export async function resumeVerifiedAlias(session: ManagedSession, receipt: ManagedReceipt) {
  if (!pendingAlias(receipt)) return;
  const original = await originalIntent(session, receipt);
  for (const reference of session.state.history) {
    if (!reference.path.startsWith('history/')) continue;
    const archive = await readManagedDisposition(session.slot.paths, reference.path.slice(8, -5));
    if (!archive || archive.stopped.command !== 'verify' || archive.outcome?.ok !== true) continue;
    const proof: PrebuiltEffectResolution | undefined = archive.stopped.prebuiltResolutions?.find(item => matchesPrebuiltResolution(original, item));
    const candidate = receipt.report.prebuilt;
    if (proof?.versionAlias?.verified && candidate?.versionAlias) return { proof,
      candidate: { ...structuredClone(candidate), versionAlias: { ...candidate.versionAlias, effect: 'accepted' as const, verified: true } } };
  }
}
