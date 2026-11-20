import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ReleaseDeployment, ReleaseDiagnostic, ReleaseReport, ReleaseStage, RunReleaseOptions } from '../contracts.js';
import type { CandidateMarkerHeaders } from './candidate-marker-auth.js';
import type { FrozenSource } from './managed-state-contracts.js';
import type { ManagedSession } from './managed-session-contracts.js';
import type { ManagedSlot } from './managed-slot-contracts.js';
import { assertActive, record, ReleaseError } from './errors.js';
import { createManagedExecution } from './managed-execution.js';
import { assertSourceFrozen, freezeManagedSource, inspectCommitTree } from './source.js';
import { openManagedSlot } from './managed-paths.js';
import { createManagedSession } from './managed-process.js';
import { assertCheckoutFrozen, prepareCheckout, prepareEnvironment } from './managed-checkout.js';
import { publishCandidate } from './publication.js';
import { diagnostic, readConfig } from './workspace-release.js';
import { recoveryCommand } from './release-commands.js';
import { loadManagedPublication, settleManagedSlot } from './managed-recovery.js';
import { archiveManagedDisposition } from './managed-disposition.js';
import { assertManagedRemoteSettled } from './managed-remote-state.js';
import { managedCommandIdentities } from './managed-observation.js';
import { managedPrebuiltContext } from './prebuilt-state.js';
import { prebuiltCandidateContext } from './version-alias.js';
import { canResealPrebuilt, resumeVerifiedAlias, selectPrebuiltContinuation } from './prebuilt-resumption.js';
import { runCompletion } from './completion.js';

export async function runManagedRelease(options: RunReleaseOptions, candidateMarkerHeaders?: CandidateMarkerHeaders): Promise<ReleaseReport> {
  const startedAt = new Date().toISOString();
  let source: FrozenSource | undefined, slot: ManagedSlot | undefined, session: ManagedSession | undefined;
  let result: ReleaseDeployment | undefined, failure: ReleaseDiagnostic | undefined, stage: ReleaseStage = 'source';
  let closed = true, retained = false;
  let expired = false, deadlineReceipt = false;
  const emptyEffects: ReleaseReport['effects'] = { developmentPush: 'not-attempted', releasePush: 'not-attempted' };
  const buildReport = (): ReleaseReport => {
    const candidateContext = source && session ? prebuiltCandidateContext(source.config, session.state.prebuilt) : undefined;
    return { schemaVersion: 2, command: options.command, ok: failure === undefined,
    startedAt, finishedAt: new Date().toISOString(), steps: session?.steps ?? [], effects: session?.state.effects ?? emptyEffects,
    stage: session?.state.stage ?? stage, ...(source ? { sourceRoot: source.root, candidateSha: source.sha, configPath: source.configPath, configSha256: source.configSha256 } : {}),
    ...(slot ? { slotId: slot.slotId, ...(session || !options.resumePrebuilt ? { runId: slot.runId } : {}), executionRoot: slot.paths.checkoutRoot } : {}),
    ...(session ? { budget: session.budget.summary(), processes: { status: closed ? 'closed' : 'unknown', knownCount: new Set(session.state.processes.flatMap(managedCommandIdentities).map(identity => `${String(identity.pid)}:${identity.startToken}`)).size } } : {}),
    ...(result ? { deployment: result } : {}), ...(failure ? { error: failure } : {}),
    ...(session?.state.prebuilt ? { prebuilt: session.state.prebuilt } : {}),
    ...(session?.state.completion ? { completion: session.state.completion } : {}),
    ...(candidateContext ? { candidateContext } : {}),
    ...(slot && source ? { recovery: { candidateSha: source.sha, reportPath: resolve(slot.paths.slotRoot, options.command === 'publish' ? 'latest-publish.json' : 'latest-check.json'),
      ...(expired ? { reportExists: deadlineReceipt } : {}),
      nextCommand: recoveryCommand(retained || !closed || Object.values(session?.state.effects ?? emptyEffects).includes('unknown') ? 'recover'
        : options.resumePrebuilt && session?.state.prebuilt?.promoteEffect !== 'accepted' ? 'status'
          : options.command === 'publish' && (session?.state.prebuilt?.deploymentId || ['pushed', 'already-current'].includes(session?.state.effects.releasePush ?? '')) ? 'verify' : options.command, source) } } : {}) };
  };
  try {
    assertActive(options.signal);
    if (options.config !== undefined) throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'COMMITTED_CONFIG_REQUIRED' });
    if (!['check', 'publish'].includes(options.command)) throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'MANAGED_RECEIPT_REQUIRED' });
    const entry = await readConfig(resolve(options.cwd, options.configPath ?? 'release.config.json'));
    const original = createManagedExecution(options.cwd, entry, options.signal, []);
    source = await freezeManagedSource(options.cwd, options.configPath ?? 'release.config.json', original);
    await inspectCommitTree(source, original);
    stage = 'admission'; await settleManagedSlot(options); slot = await openManagedSlot(source, original, options.command === 'publish' ? 'publish' : 'check');
    const selected = options.resumePrebuilt ? await loadManagedPublication(source.root, source.configPath, undefined, options.signal) : undefined;
    const previous = selected?.receipt ?? (source.config.delivery && options.command === 'publish' ? await slot.store.readReceipt('publish') : undefined);
    const continuation = options.resumePrebuilt ? await selectPrebuiltContinuation(slot, options.resumePrebuilt, previous, options.signal, selected?.reportExists) : undefined;
    session = await createManagedSession(slot, options.command === 'publish' ? 'publish' : 'check', options.signal);
    const currentSession = session, frozen = source;
    if (previous?.source.sha === source.sha && previous.source.configSha256 === source.configSha256 && previous.report.prebuilt
      && (continuation || !await canResealPrebuilt(session, previous))) {
      const resumed = await resumeVerifiedAlias(session, previous);
      session.state.prebuilt = resumed?.candidate ?? structuredClone(previous.report.prebuilt);
      session.state.effects.deploymentCreate = session.state.prebuilt.createEffect;
      session.state.effects.deploymentPromote = session.state.prebuilt.promoteEffect;
      if (session.state.prebuilt.versionAlias) session.state.effects.versionAliasAssign = session.state.prebuilt.versionAlias.effect;
      if (resumed) session.state.prebuiltResolutions = [resumed.proof];
      if (continuation) session.state.checkoutIdentity = continuation.checkout;
      await session.persist();
    }
    let previousPublish;
    try {
      const anchor = record(JSON.parse(await readFile(slot.paths.anchorPath, 'utf8')) as unknown);
      if (anchor.slotId !== slot.slotId || anchor.configPath !== source.configPath || anchor.sourceRoot !== source.root) throw new ReleaseError('SLOT_STATE', { reason: 'ANCHOR_MISMATCH' });
      previousPublish = record(anchor.latestPublish);
    } catch (error) { if (record(error).code !== 'ENOENT') throw error; }
    await slot.store.writeAnchor({ schemaVersion: 2, slotId: slot.slotId, slotPath: slot.paths.slotRoot, sourceRoot: source.root, configPath: source.configPath,
      ...(options.command === 'publish' ? { latestPublish: { sha: source.sha, runId: slot.runId, configSha256: source.configSha256 } }
        : previousPublish && typeof previousPublish.sha === 'string' && typeof previousPublish.runId === 'string' && typeof previousPublish.configSha256 === 'string' ? { latestPublish: { sha: previousPublish.sha, runId: previousPublish.runId, configSha256: previousPublish.configSha256 } } : {}) });
    if (!continuation) { await prepareCheckout(session); await prepareEnvironment(session); }
    const assertFrozen = async () => { await continuation?.assertCheckout(); await assertSourceFrozen(frozen, original); await assertCheckoutFrozen(currentSession); };
    if (continuation) await assertFrozen();
    result = await publishCandidate({ execution: session.execution, config: source.config, sha: source.sha, signal: options.signal, transport: options.transport, buildInfoHttp: options.buildInfoHttp,
      effects: session.state.effects, assertFrozen, candidateMarkerHeaders, vercelApiHttp: options.vercelApiHttp, resumePrebuilt: continuation !== undefined,
      prebuilt: managedPrebuiltContext(session),
      mutationGuard: async effect => { await assertFrozen(); await currentSession.assertClosed(); await currentSession.budget.sample(); await currentSession.slot.lock.assertOwned();
        return assertManagedRemoteSettled(currentSession.slot.paths, currentSession.execution, effect ? { effect, source: frozen } : undefined, options.transport,
          async proof => {
            const previous = currentSession.state.prebuiltResolutions ?? [];
            if (previous.some(item => item.runId === proof.runId)) return;
            if (previous.length >= 1000) throw new ReleaseError('BUDGET_EXCEEDED', { reason: 'PREBUILT_RESOLUTION_LIMIT' });
            currentSession.state.prebuiltResolutions = [...previous, proof]; await currentSession.persist();
          }, options.buildInfoHttp, candidateMarkerHeaders, options.vercelApiHttp); },
      stage: async value => { currentSession.state.stage = value; await currentSession.persist(); },
      checkpoint: async pending => { if (pending) currentSession.state.pendingPush = pending; else delete currentSession.state.pendingPush; await currentSession.persist(); } }, options.command === 'publish' ? 'publish' : 'check');
    await runCompletion(session, options, assertFrozen, candidateMarkerHeaders);
    await assertFrozen(); await session.assertClosed(); await session.budget.sample(); session.state.stage = 'complete';
  } catch (error) { failure = diagnostic(error); }
  expired = failure?.code === 'BUDGET_UNKNOWN' && failure.details.reason === 'OBSERVATION_DEADLINE';
  if (session) {
    try { await session.assertStopped(); } catch { closed = false; }
    // 截止后保留原锁，避免收尾重新扫描整个 payload。
    retained = !closed || expired;
    session.state.status = retained ? 'unknown' : 'closed';
    if (expired) {
      try {
        deadlineReceipt = true;
        await session.slot.store.writeReceipt(options.command === 'publish' ? 'publish' : 'check',
          { schemaVersion: 2, slotId: session.slot.slotId, source: session.slot.source, report: buildReport() }, 'observation-deadline');
      } catch { deadlineReceipt = false; }
    } else try {
      await session.persist();
      await session.slot.store.writeReceipt(options.command === 'publish' ? 'publish' : 'check', { schemaVersion: 2, slotId: session.slot.slotId, source: session.slot.source, report: buildReport() });
      if (closed) {
        const completed = session;
        await completed.assertStopped();
        await archiveManagedDisposition(completed.slot.paths, completed.state, completed.state, () => completed.slot.lock.assertOwned(), undefined, false, buildReport());
      }
    } catch (error) { failure ??= diagnostic(error); retained = true; }
  }
  if (slot && !retained) { try { await slot.lock.release(); } catch (error) { failure ??= diagnostic(error); retained = true; } }
  try { await slot?.coordinatorLease?.release(); } catch (error) { failure ??= diagnostic(error); retained = true; }
  return buildReport();
}
