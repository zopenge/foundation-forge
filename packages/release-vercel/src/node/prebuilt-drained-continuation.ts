import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { drainedAcceptanceCandidate } from './drained-retirement.js';
import { record, ReleaseError } from './errors.js';
import { readManagedDisposition, type ManagedDisposition } from './managed-disposition.js';
import { readBoundedJson, sameIdentity } from './managed-io.js';
import { parseManagedState } from './managed-state.js';
import type { FrozenSource, ManagedHistoryReference, ManagedPaths, ManagedState, MetadataFile } from './managed-state-contracts.js';
import type { ManagedPrebuiltSelection, ManagedSlot } from './managed-slot-contracts.js';
import { readRetirementRecord, retirementArchivePath } from './retirement-record.js';
import type { RetirementHost } from './retirement-host.js';

export async function readDrainedAcceptance(paths: ManagedPaths, slotId: string, runId: string, expected?: MetadataFile) {
  const evidence = await readRetirementRecord(retirementArchivePath(paths, runId), paths, expected);
  if (expected && !evidence) throw new ReleaseError('SLOT_STATE', { reason: 'HISTORY_MISSING' });
  if (evidence?.final?.cessation !== 'recorded-empty-drained-scope') return;
  const input: unknown = JSON.parse(evidence.snapshot.state);
  if (record(input).stage !== 'acceptance') return;
  const state = parseManagedState(input, record(input).source as FrozenSource, slotId);
  const candidate = drainedAcceptanceCandidate(state);
  if (!candidate || state.runId !== runId || evidence.slotId !== slotId || state.source.root !== paths.sourceRoot
    || state.source.config.source.mode !== 'managed-commit' || resolve(paths.sourceRoot, state.source.config.source.slotPath) !== paths.slotRoot)
    throw new ReleaseError('SLOT_STATE', { reason: 'DRAINED_ACCEPTANCE_BINDING' });
  return { evidence, state, candidate };
}

type DrainedAcceptance = NonNullable<Awaited<ReturnType<typeof readDrainedAcceptance>>>;

function bindsRetiredAcceptance(archive: ManagedDisposition, original: DrainedAcceptance, reference: ManagedHistoryReference): boolean {
  const { candidate, state } = original, published = archive.stopped, successor = published.prebuilt;
  const ceased = published.status === 'closed' || (archive.observation?.owner === 'inactive' && archive.observation.processes === 'closed');
  return ceased && published.slotId === state.slotId && published.source.root === state.source.root
    && published.source.configPath === state.source.configPath && successor?.sourceSha === candidate.sourceSha
    && successor.configSha256 === candidate.configSha256 && successor.artifactSha256 === candidate.artifactSha256
    && successor.deploymentId === candidate.deploymentId && successor.deploymentUrl === candidate.deploymentUrl
    && !!published.checkoutIdentity && !!state.checkoutIdentity && sameIdentity(published.checkoutIdentity, state.checkoutIdentity)
    && published.history.some(item => item.path === reference.path && item.file.sha256 === reference.file.sha256
      && sameIdentity(item.file.identity, reference.file.identity));
}

async function readPublicationHistory(paths: ManagedPaths, current: ManagedState, disposition?: MetadataFile): Promise<ManagedDisposition[]> {
  const archives: ManagedDisposition[] = [];
  for (const reference of current.history) {
    if (!reference.path.startsWith('history/')) continue;
    const archive = await readManagedDisposition(paths, reference.path.slice(8, -5), reference.file);
    if (!archive) throw new ReleaseError('SLOT_STATE', { reason: 'HISTORY_MISSING' });
    archives.push(archive);
  }
  if (disposition) {
    const latest = await readManagedDisposition(paths, current.runId, disposition);
    if (!latest) throw new ReleaseError('SLOT_STATE', { reason: 'HISTORY_MISSING' });
    archives.push(latest);
  }
  return archives;
}

/** 原槽锁内保护未推广的制品。后继发布绑定原归档并核验推广后才解除保护。 */
export async function admitDrainedAcceptance(paths: ManagedPaths, current: ManagedState, source: FrozenSource,
  options: { command?: ManagedState['command']; prebuilt?: ManagedPrebuiltSelection; host?: RetirementHost; retirement?: MetadataFile;
    disposition?: MetadataFile }): Promise<ManagedSlot['drainedAcceptance']> {
  const { command, prebuilt, host, retirement, disposition } = options, binding = prebuilt?.binding;
  const retired = current.history.filter(entry => entry.path.startsWith('retired/'));
  if (retirement) retired.push({ path: 'retired/' + current.runId + '.json', file: retirement });
  const history: ManagedHistoryReference[] = [];
  let publications: ManagedDisposition[] | undefined, verificationCheckout: NonNullable<ManagedSlot['drainedAcceptance']>['verificationCheckout'];
  for (const entry of retired) {
    const original = await readDrainedAcceptance(paths, current.slotId, entry.path.slice(8, -5), entry.file);
    if (!original) {
      if (entry.file === retirement) throw new ReleaseError('SLOT_STATE', { reason: 'DRAINED_ACCEPTANCE_BINDING' });
      continue;
    }
    const { candidate, state } = original;
    publications ??= await readPublicationHistory(paths, current, disposition);
    const successors = publications.filter(archive => bindsRetiredAcceptance(archive, original, entry));
    if (successors.some(({ stopped }) => (stopped.command === 'publish' || stopped.command === 'verify')
      && stopped.prebuilt?.promoteEffect === 'accepted' && stopped.prebuilt.promotionVerified && stopped.prebuilt.acceptanceVerified)) continue;
    if (host?.hostId !== state.host.hostId || host.platform !== state.host.platform)
      throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'RETIREMENT_HOST_CHANGED' });
    if (binding && binding.deploymentId === candidate.deploymentId && binding.artifactSha256 === candidate.artifactSha256
      && binding.sha === candidate.sourceSha && binding.configSha256 === candidate.configSha256
      && source.root === state.source.root && source.configPath === state.source.configPath
      && source.sha === binding.sha && source.configSha256 === binding.configSha256) {
      if (command === 'publish') { history.push(entry); continue; }
      const verification = prebuilt?.verification;
      if (command === 'verify' && verification && successors.some(({ stopped, snapshot }) => stopped.command === 'publish' && stopped.runId === binding.runId
        && stopped.prebuilt?.acceptanceVerified && stopped.prebuilt.promoteEffect !== 'not-attempted'
        && isDeepStrictEqual(stopped.prebuilt, verification.receipt.report.prebuilt)
        && isDeepStrictEqual(stopped.effects, verification.receipt.report.effects)
        && (!verification.reportExists || isDeepStrictEqual(JSON.parse(snapshot.publish ?? 'null'), verification.receipt)))) {
        const anchor = record(await readBoundedJson(paths.anchorPath, 65_536)), latest = record(anchor.latestPublish);
        if (latest.runId === binding.runId && latest.sha === binding.sha && latest.configSha256 === binding.configSha256) {
          verificationCheckout = state.checkoutIdentity;
          history.push(entry);
          continue;
        }
      }
    }
    throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'PREBUILT_ACCEPTANCE_RESUME_REQUIRED', runId: state.runId, deploymentId: candidate.deploymentId });
  }
  return history.length ? { history, ...(verificationCheckout ? { verificationCheckout } : {}) } : undefined;
}
