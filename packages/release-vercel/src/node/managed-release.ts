import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ReleaseDeployment, ReleaseDiagnostic, ReleaseReport, ReleaseStage, RunReleaseOptions } from '../contracts.js';
import type { FrozenSource, ManagedSession, ManagedSlot } from './release-context.js';
import { assertActive, record, ReleaseError } from './errors.js';
import { createManagedExecution } from './managed-execution.js';
import { assertSourceFrozen, freezeManagedSource, inspectCommitTree } from './source.js';
import { openManagedSlot } from './managed-paths.js';
import { createManagedSession } from './managed-process.js';
import { assertCheckoutFrozen, prepareCheckout, prepareEnvironment } from './managed-checkout.js';
import { publishCandidate } from './publication.js';
import { diagnostic, readConfig } from './workspace-release.js';
import { recoveryCommand } from './release-commands.js';
import { settleManagedSlot } from './managed-recovery.js';
import { archiveManagedDisposition } from './managed-disposition.js';
import { assertManagedRemoteSettled } from './managed-remote-state.js';
import { managedCommandIdentities } from './managed-observation.js';
import { managedPrebuiltContext } from './prebuilt-state.js';
import { prebuiltCandidateContext } from './version-alias.js';
import { resumeVerifiedAlias } from './prebuilt-resumption.js';
import { runCompletion } from './completion.js';

export async function runManagedRelease(options: RunReleaseOptions): Promise<ReleaseReport> {
  const startedAt = new Date().toISOString();
  let source: FrozenSource | undefined, slot: ManagedSlot | undefined, session: ManagedSession | undefined;
  let result: ReleaseDeployment | undefined, failure: ReleaseDiagnostic | undefined, stage: ReleaseStage = 'source';
  let closed = true, retained = false;
  const emptyEffects: ReleaseReport['effects'] = { developmentPush: 'not-attempted', releasePush: 'not-attempted' };
  const buildReport = (): ReleaseReport => {
    const candidateContext = source && session ? prebuiltCandidateContext(source.config, session.state.prebuilt) : undefined;
    return { schemaVersion: 2, command: options.command, ok: failure === undefined,
    startedAt, finishedAt: new Date().toISOString(), steps: session?.steps ?? [], effects: session?.state.effects ?? emptyEffects,
    stage: session?.state.stage ?? stage, ...(source ? { sourceRoot: source.root, candidateSha: source.sha, configPath: source.configPath, configSha256: source.configSha256 } : {}),
    ...(slot ? { slotId: slot.slotId, runId: slot.runId, executionRoot: slot.paths.checkoutRoot } : {}),
    ...(session ? { budget: session.budget.summary(), processes: { status: closed ? 'closed' : 'unknown', knownCount: new Set(session.state.processes.flatMap(managedCommandIdentities).map(identity => `${String(identity.pid)}:${identity.startToken}`)).size } } : {}),
    ...(result ? { deployment: result } : {}), ...(failure ? { error: failure } : {}),
    ...(session?.state.prebuilt ? { prebuilt: session.state.prebuilt } : {}),
    ...(session?.state.completion ? { completion: session.state.completion } : {}),
    ...(candidateContext ? { candidateContext } : {}),
    ...(slot && source ? { recovery: { candidateSha: source.sha, reportPath: resolve(slot.paths.slotRoot, options.command === 'publish' ? 'latest-publish.json' : 'latest-check.json'),
      nextCommand: recoveryCommand(retained || !closed || Object.values(session?.state.effects ?? emptyEffects).includes('unknown') ? 'recover' : options.command === 'publish' && (session?.state.prebuilt?.deploymentId || ['pushed', 'already-current'].includes(session?.state.effects.releasePush ?? '')) ? 'verify' : options.command, source) } } : {}) };
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
    session = await createManagedSession(slot, options.command === 'publish' ? 'publish' : 'check', options.signal);
    const currentSession = session, frozen = source;
    if (source.config.delivery && options.command === 'publish') {
      const previous = await slot.store.readReceipt('publish');
      if (previous?.source.sha === source.sha && previous.source.configSha256 === source.configSha256 && previous.report.prebuilt) {
        const resumed = await resumeVerifiedAlias(session, previous);
        session.state.prebuilt = resumed?.candidate ?? structuredClone(previous.report.prebuilt);
        session.state.effects.deploymentCreate = session.state.prebuilt.createEffect;
        session.state.effects.deploymentPromote = session.state.prebuilt.promoteEffect;
        if (session.state.prebuilt.versionAlias) session.state.effects.versionAliasAssign = session.state.prebuilt.versionAlias.effect;
        if (resumed) session.state.prebuiltResolutions = [resumed.proof];
        await session.persist();
      }
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
    await prepareCheckout(session); await prepareEnvironment(session);
    const assertFrozen = async () => { await assertSourceFrozen(frozen, original); await assertCheckoutFrozen(currentSession); };
    result = await publishCandidate({ execution: session.execution, config: source.config, sha: source.sha, signal: options.signal, transport: options.transport,
      effects: session.state.effects, assertFrozen,
      prebuilt: managedPrebuiltContext(session),
      mutationGuard: async effect => { await assertFrozen(); await currentSession.assertClosed(); await currentSession.budget.sample(); await currentSession.slot.lock.assertOwned();
        return assertManagedRemoteSettled(currentSession.slot.paths, currentSession.execution, effect ? { effect, source: frozen } : undefined, options.transport,
          async proof => {
            const previous = currentSession.state.prebuiltResolutions ?? [];
            if (previous.some(item => item.runId === proof.runId)) return;
            if (previous.length >= 1000) throw new ReleaseError('BUDGET_EXCEEDED', { reason: 'PREBUILT_RESOLUTION_LIMIT' });
            currentSession.state.prebuiltResolutions = [...previous, proof]; await currentSession.persist();
          }); },
      stage: async value => { currentSession.state.stage = value; await currentSession.persist(); },
      checkpoint: async pending => { if (pending) currentSession.state.pendingPush = pending; else delete currentSession.state.pendingPush; await currentSession.persist(); } }, options.command === 'publish' ? 'publish' : 'check');
    await runCompletion(session, options, assertFrozen);
    await assertFrozen(); await session.assertClosed(); await session.budget.sample(); session.state.stage = 'complete';
  } catch (error) { failure = diagnostic(error); }
  if (session) {
    try { await session.assertStopped(); } catch { closed = false; }
    retained = !closed;
    session.state.status = retained ? 'unknown' : 'closed';
    try {
      await session.persist();
      await session.slot.store.writeReceipt(options.command === 'publish' ? 'publish' : 'check', { schemaVersion: 2, slotId: session.slot.slotId, source: session.slot.source, report: buildReport() });
      if (closed) {
        const completed = session;
        await completed.assertStopped();
        await archiveManagedDisposition(completed.slot.paths, completed.state, completed.state, () => completed.slot.lock.assertOwned(), undefined, false, buildReport());
      }
    } catch (error) { failure ??= diagnostic(error); retained = true; }
  }
  if (slot && !retained) { try { await slot.lock.release(); } catch (error) { failure = diagnostic(error); retained = true; } }
  return buildReport();
}
