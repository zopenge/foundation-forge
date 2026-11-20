import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { NodeHttpTransportOptions } from '@openge/forge-http-transport';
import type { PrebuiltResumeBinding, ReleaseTransport } from '../contracts.js';
import type { FrozenSource, ManagedReceipt, ManagedState, PrebuiltEffectResolution } from './managed-state-contracts.js';
import type { ManagedSession } from './managed-session-contracts.js';
import type { ManagedSlot } from './managed-slot-contracts.js';
import type { CandidateMarkerHeaders } from './candidate-marker-auth.js';
import { record, ReleaseError } from './errors.js';
import { assertManagedHistory } from './managed-history.js';
import { readManagedDisposition } from './managed-disposition.js';
import { assertMetadataFile } from './managed-metadata.js';
import { fileIdentity, readBoundedJson, sameIdentity } from './managed-io.js';
import { parseManagedState } from './managed-state.js';
import { readRetirementRecord } from './retirement-record.js';
import { assertPrebuiltEffectObserved, matchesPrebuiltResolution } from './prebuilt-recovery.js';
import { assertRecordedPrebuiltArtifact } from './prebuilt-artifact.js';

function hasAttemptedEffect(state: Pick<ManagedState, 'effects' | 'pendingPush' | 'completion'>): boolean {
  return !!state.pendingPush || !!state.completion || Object.values(state.effects).some(effect => effect !== 'not-attempted');
}

async function stoppedPublication(slot: ManagedSlot, receipt: ManagedReceipt, reportExists = true): Promise<ManagedState | undefined> {
  const { paths, slotId } = slot, report = receipt.report;
  if (!report.runId || report.command !== 'publish' || !report.prebuilt) return;
  const archive = await readManagedDisposition(paths, report.runId);
  if (!archive || archive.slotId !== slotId || archive.stopped.command !== 'publish'
    || !isDeepStrictEqual(archive.stopped.source, receipt.source) || !isDeepStrictEqual(archive.stopped.prebuilt, report.prebuilt)
    || !isDeepStrictEqual(archive.stopped.effects, report.effects)) return;
  if (reportExists && (!archive.snapshot.publish || !isDeepStrictEqual(JSON.parse(archive.snapshot.publish), receipt))) return;
  if (!reportExists) {
    const anchor = record(record(JSON.parse(archive.snapshot.anchor ?? 'null')).latestPublish);
    if (anchor.runId !== archive.runId || anchor.sha !== receipt.source.sha || anchor.configSha256 !== receipt.source.configSha256) return;
  }
  await assertMetadataFile(resolve(paths.slotRoot, 'latest-publish.json'), archive.files.publish);
  return archive.stopped;
}

/** 原槽独占锁内，先绑定已停止的原始候选，再允许调用方创建新运行。 */
export async function selectPrebuiltContinuation(slot: ManagedSlot, binding: PrebuiltResumeBinding, receipt?: ManagedReceipt, signal?: AbortSignal,
  reportExists = true) {
  const { source, paths } = slot, candidate = receipt?.report.prebuilt;
  if (!source.config.delivery || !receipt || candidate?.createEffect !== 'accepted' || receipt.report.runId !== binding.runId
    || source.sha !== binding.sha || source.configSha256 !== binding.configSha256
    || candidate.sourceSha !== binding.sha || candidate.configSha256 !== binding.configSha256
    || candidate.artifactSha256 !== binding.artifactSha256 || candidate.deploymentId !== binding.deploymentId)
    throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'PREBUILT_RESUME_BINDING' });
  const selected = record(record(await readBoundedJson(paths.anchorPath, 65_536)).latestPublish);
  const stopped = await stoppedPublication(slot, receipt, reportExists);
  if (!stopped?.checkoutIdentity || selected.runId !== binding.runId || selected.sha !== binding.sha || selected.configSha256 !== binding.configSha256)
    throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'PREBUILT_RESUME_STOP_UNPROVEN' });
  const checkout = stopped.checkoutIdentity;
  const assertCheckout = async () => {
    await slot.lock.assertOwned();
    const current = await fileIdentity(paths.checkoutRoot).catch(() => undefined);
    if (!current || !sameIdentity(current, checkout))
      throw new ReleaseError('ARTIFACT_CHANGED', { reason: 'PREBUILT_RESUME_CHECKOUT' });
  };
  await assertCheckout();
  await assertRecordedPrebuiltArtifact(paths.checkoutRoot, source.config, candidate, signal);
  return { checkout, assertCheckout };
}

/** 只有同一收据有完整停止证明，且同一候选历史未尝试远端写入，才允许重做封存。 */
export async function canResealPrebuilt(session: ManagedSession, receipt: ManagedReceipt): Promise<boolean> {
  const { report } = receipt, { paths, slotId } = session.slot;
  if (report.command !== 'publish' || report.ok || !report.runId || !report.prebuilt || report.deployment || hasAttemptedEffect(report)) return false;
  const selectedPath = `history/${report.runId}.json`;
  if (!session.state.history.some(reference => reference.path === selectedPath)) return false;
  await assertManagedHistory(paths, session.state);
  const stopped = await stoppedPublication(session.slot, receipt);
  if (!stopped || hasAttemptedEffect(stopped)) return false;
  for (const reference of session.state.history) {
    if (reference.path === selectedPath) continue;
    let prior: ManagedState;
    if (reference.path.startsWith('history/')) {
      const evidence = await readManagedDisposition(paths, reference.path.slice(8, -5));
      if (!evidence) throw new ReleaseError('SLOT_STATE', { reason: 'HISTORY_MISSING' });
      prior = evidence.stopped;
    } else {
      const evidence = await readRetirementRecord(resolve(paths.slotRoot, reference.path), paths);
      if (!evidence?.final) throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'RETIREMENT_INCOMPLETE' });
      const value: unknown = JSON.parse(evidence.snapshot.state);
      prior = parseManagedState(value, record(value).source as FrozenSource, slotId);
    }
    if (prior.source.sha === receipt.source.sha && prior.source.configSha256 === receipt.source.configSha256 && hasAttemptedEffect(prior)) return false;
  }
  await assertManagedHistory(paths, session.state);
  return true;
}

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
export async function recordVerifiedAlias(session: ManagedSession, receipt: ManagedReceipt, transport?: ReleaseTransport, http?: NodeHttpTransportOptions,
  candidateMarkerHeaders?: CandidateMarkerHeaders, apiHttp?: NodeHttpTransportOptions): Promise<void> {
  if (!pendingAlias(receipt)) return;
  const original = await originalIntent(session, receipt);
  const proof = await assertPrebuiltEffectObserved(original, session.execution, transport, http, candidateMarkerHeaders, apiHttp);
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
