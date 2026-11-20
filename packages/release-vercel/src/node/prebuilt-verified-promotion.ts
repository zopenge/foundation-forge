import type { ReleaseReport } from '../contracts.js';
import { isDeepStrictEqual } from 'node:util';
import { selectCompletionSnapshots } from './completion-history.js';
import { hasVerifiedManagedClosure } from './managed-closure.js';
import { parseManagedReceipt } from './managed-state.js';
import type { ManagedHistoryReference, ManagedState, MetadataFile, PrebuiltEffectResolution } from './managed-state-contracts.js';
import { matchesPrebuiltResolution } from './prebuilt-recovery.js';

export interface BoundPrebuiltArchive {
  readonly state: ManagedState;
  readonly reference: ManagedHistoryReference;
  readonly publishFile: MetadataFile;
  readonly publishReceipt: string;
  readonly outcome?: ReleaseReport;
}

/** 只消费已经封存的 verify 结果。历史引用证明先有原意图归档，后有验证运行。 */
export function archivedPromotionResolution(origin: BoundPrebuiltArchive, verification: BoundPrebuiltArchive): PrebuiltEffectResolution | undefined {
  const original = origin.state, verified = verification.state, report = verification.outcome;
  const before = original.prebuilt, after = verified.prebuilt;
  if (original.command !== 'publish' || !before?.deploymentId || before.createEffect !== 'accepted' || before.versionAlias
    || !before.acceptanceVerified || before.promoteEffect === 'not-attempted' || before.promotionVerified) return;
  if (verified.command !== 'verify' || verified.status !== 'closed' || verified.stage !== 'complete' || !report?.ok
    || report.command !== 'verify' || report.stage !== 'complete' || report.error || report.processes?.status !== 'closed'
    || report.runId !== verified.runId || report.slotId !== original.slotId || verified.slotId !== original.slotId
    || report.sourceRoot !== original.source.root || report.configPath !== original.source.configPath
    || !Number.isFinite(Date.parse(report.finishedAt)) || !verified.processes.every(hasVerifiedManagedClosure)
    || !isDeepStrictEqual(verified.source, original.source)
    || !verified.history.some(previous => isDeepStrictEqual(previous, origin.reference))) return;
  if (verification.publishReceipt !== origin.publishReceipt || !isDeepStrictEqual(origin.publishFile, verification.publishFile)) return;
  const { source, report: published } = parseManagedReceipt(JSON.parse(origin.publishReceipt), original.source, original.slotId);
  if (published.command !== 'publish' || published.runId !== original.runId || !isDeepStrictEqual(source, original.source)
    || !isDeepStrictEqual(published.prebuilt, before)) return;
  const deployment = report.deployment;
  if (!after || after.promoteEffect !== 'accepted' || !after.promotionVerified
    || !isDeepStrictEqual(after, { ...before, promoteEffect: 'accepted', promotionVerified: true })
    || !isDeepStrictEqual(report.prebuilt, after) || !isDeepStrictEqual(report.completion, verified.completion)
    || deployment?.id !== before.deploymentId || deployment.url !== before.deploymentUrl || deployment.state !== 'READY'
    || deployment.sha !== original.source.sha || deployment.projectId !== original.source.config.vercel.projectId) return;
  if (original.source.config.completion) {
    const completion = verified.completion, completedRun = completion?.attempts.at(-1)?.runId;
    if (completion?.status !== 'completed' || completion.publicationRunId !== original.runId
      || (completedRun !== original.runId && completedRun !== verified.runId)
      || !selectCompletionSnapshots([original, verified]).some(snapshot => snapshot.origin === original && snapshot.completion.status === 'completed')) return;
  }
  const proof: PrebuiltEffectResolution = { schemaVersion: 1, runId: original.runId, sourceSha: original.source.sha,
    configSha256: original.source.configSha256, artifactSha256: before.artifactSha256, deploymentId: before.deploymentId,
    promotion: 'succeeded', observedAt: report.finishedAt };
  if (matchesPrebuiltResolution(original, proof)) return proof;
}
