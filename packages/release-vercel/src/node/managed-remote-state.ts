import { opendir } from 'node:fs/promises';
import type { NodeHttpTransportOptions } from '@openge/forge-http-transport';
import { resolve } from 'node:path';
import type { Execution } from './execution.js';
import type { CandidateMarkerHeaders } from './candidate-marker-auth.js';
import type { FrozenSource, ManagedPaths, ManagedState, PrebuiltEffectResolution } from './managed-state-contracts.js';
import { assertPathChain, pathExists, readBoundedJson } from './managed-io.js';
import { readManagedDisposition } from './managed-disposition.js';
import { readRetirementRecord } from './retirement-record.js';
import { parseManagedState } from './managed-state.js';
import { frozenSource, observeRefsForDisposition, readManagedLocation } from './managed-recovery.js';
import { assertHistoricalSource } from './source.js';
import { record, ReleaseError } from './errors.js';
import { assertManagedHistory, historyFileLimit } from './managed-history.js';
import { assertMetadataFile } from './managed-metadata.js';
import type { ReleaseTransport } from '../contracts.js';
import { assertPrebuiltEffectObserved, hasUnresolvedPrebuiltEffect, matchesPrebuiltResolution } from './prebuilt-recovery.js';
import { archivedPromotionResolution, type BoundPrebuiltArchive } from './prebuilt-verified-promotion.js';

/** 每次新的远端写入前重新观察全部历史未决意图；本地 check 不会抹去它们。 */
export async function assertManagedRemoteSettled(paths: ManagedPaths, execution: Execution,
  intent?: { readonly effect: 'developmentPush' | 'releasePush'; readonly source: FrozenSource }, transport?: ReleaseTransport,
  persistResolution?: (proof: PrebuiltEffectResolution) => Promise<void>, http?: NodeHttpTransportOptions,
  candidateMarkerHeaders?: CandidateMarkerHeaders, apiHttp?: NodeHttpTransportOptions): Promise<'already-current' | undefined> {
  const active = record(await readBoundedJson(paths.statePath));
  const current = parseManagedState(active, active.source as ManagedState['source'], String(active.slotId));
  await assertManagedHistory(paths, current);
  let count = 0, alreadyCurrent = false;
  const history: ManagedState[] = [];
  const resolutions = [...(current.prebuiltResolutions ?? [])];
  const references = new Map(current.history.map(reference => [reference.path, reference]));
  const publications = new Map<string, BoundPrebuiltArchive>();
  const verifications = new Map<string, BoundPrebuiltArchive[]>();
  for (const kind of ['history', 'retired'] as const) {
    const directory = resolve(paths.slotRoot, kind); await assertPathChain(paths.slotRoot, directory);
    if (!await pathExists(directory)) continue;
    for await (const entry of await opendir(directory)) {
      if (++count > 10_000) throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'HISTORY_LIMIT' });
      if (!entry.isFile() || !/^[a-f0-9-]{36}\.json$/u.test(entry.name)) throw new ReleaseError('SLOT_STATE', { reason: 'HISTORY_ENTRY' });
      let state: ManagedState;
      if (kind === 'history') {
        const reference = references.get(`history/${entry.name}`);
        const evidence = await readManagedDisposition(paths, entry.name.slice(0, -5), reference?.file);
        if (!evidence) throw new ReleaseError('SLOT_STATE', { reason: 'HISTORY_MISSING' });
        state = evidence.stopped;
        const publishFile = evidence.files.publish;
        const publishReceipt = evidence.snapshot.publish, outcome = evidence.outcome;
        if (reference && publishFile && publishReceipt && state.prebuilt && !state.prebuilt.versionAlias
          && state.slotId === current.slotId && state.source.root === paths.sourceRoot) {
          const bound: BoundPrebuiltArchive = { state, reference, publishFile, publishReceipt, ...(outcome ? { outcome } : {}) };
          if (state.command === 'publish' && hasUnresolvedPrebuiltEffect(state)) publications.set(state.runId, bound);
          if (state.command === 'verify' && outcome?.ok === true && state.prebuilt.promotionVerified) {
            const group = verifications.get(publishFile.sha256) ?? [];
            group.push(bound); verifications.set(publishFile.sha256, group);
          }
        }
        if (state.command !== 'verify' || evidence.outcome?.ok === true) resolutions.push(...(state.prebuiltResolutions ?? []));
      } else {
        const evidence = await readRetirementRecord(resolve(directory, entry.name), paths);
        if (!evidence?.final) throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'RETIREMENT_INCOMPLETE' });
        const value: unknown = JSON.parse(evidence.snapshot.state), source = record(value).source as ManagedState['source'];
        state = parseManagedState(value, source, evidence.slotId);
        if (state.command !== 'verify') resolutions.push(...(state.prebuiltResolutions ?? []));
      }
      history.push(state);
    }
  }
  for (const proof of resolutions) {
    if (!history.some(original => matchesPrebuiltResolution(original, proof))) throw new ReleaseError('SLOT_STATE', { reason: 'PREBUILT_RESOLUTION_SOURCE' });
  }
  for (const state of history) {
      // verify 只复用原 publish 的远端效果供观察，失败时的快照不产生新的写入意图。
      if (state.command !== 'verify' && hasUnresolvedPrebuiltEffect(state) && !resolutions.some(proof => matchesPrebuiltResolution(state, proof))) {
        const location = await readManagedLocation(paths.sourceRoot, state.source.configPath);
        frozenSource(state.source, location); await assertHistoricalSource(state.source, execution.signal);
        const original = publications.get(state.runId);
        let proof: PrebuiltEffectResolution | undefined;
        if (original) for (const verification of verifications.get(original.publishFile.sha256) ?? []) {
          proof = archivedPromotionResolution(original, verification);
          if (!proof) continue;
          for (const { reference } of [original, verification])
            await assertMetadataFile(resolve(paths.slotRoot, reference.path), reference.file, historyFileLimit);
          break;
        }
        proof ??= await assertPrebuiltEffectObserved(state, execution, transport, http, candidateMarkerHeaders, apiHttp);
        if (proof) {
          if (!persistResolution) throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'PREBUILT_RESOLUTION_NOT_RECORDED' });
          await persistResolution(proof); resolutions.push(proof);
        }
      }
      const unresolved = (['developmentPush', 'releasePush'] as const).filter(effect => state.effects[effect] === 'unknown' || state.pendingPush === effect);
      if (unresolved.length === 0) continue;
      const location = await readManagedLocation(paths.sourceRoot, state.source.configPath);
      frozenSource(state.source, location);
      await assertHistoricalSource(state.source, execution.signal);
      const refs = await observeRefsForDisposition(execution, state.source, { owner: 'inactive', processes: 'closed', knownCount: 0 });
      for (const effect of unresolved) {
        const ref = effect === 'developmentPush' ? refs.developmentRef : refs.releaseRef;
        if (!ref || !['candidate', 'superseded'].includes(ref.relation)) throw new ReleaseError('RECOVERY_REQUIRED', {
          reason: 'REMOTE_EFFECT_UNRESOLVED', runId: state.runId, effect, relation: ref?.relation ?? 'unknown', sha: ref?.sha ?? '',
        });
        const branch = effect === 'developmentPush' ? 'developmentBranch' : 'releaseBranch';
        if (intent?.effect === effect && intent.source.sha === state.source.sha && ref.relation === 'candidate'
          && intent.source.config.git[branch] === state.source.config.git[branch]
          && intent.source.config.git.repository === state.source.config.git.repository) alreadyCurrent = true;
      }
  }
  return alreadyCurrent ? 'already-current' : undefined;
}
