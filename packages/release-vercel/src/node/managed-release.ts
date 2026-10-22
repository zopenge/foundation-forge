import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ReleaseDeployment, ReleaseDiagnostic, ReleaseReport, ReleaseStage, RunReleaseOptions } from '../contracts.js';
import type { FrozenSource, ManagedSession, ManagedSlot } from './release-context.js';
import { assertActive, record, ReleaseError } from './errors.js';
import { Execution } from './execution.js';
import { assertSourceFrozen, freezeManagedSource, inspectCommitTree } from './source.js';
import { openManagedSlot } from './managed-paths.js';
import { createManagedSession } from './managed-process.js';
import { assertCheckoutFrozen, prepareCheckout, prepareEnvironment } from './managed-checkout.js';
import { publishCandidate } from './publication.js';
import { diagnostic, readConfig } from './workspace-release.js';
import { recoveryCommand } from './release-commands.js';

export async function runManagedRelease(options: RunReleaseOptions): Promise<ReleaseReport> {
  const startedAt = new Date().toISOString();
  let source: FrozenSource | undefined, slot: ManagedSlot | undefined, session: ManagedSession | undefined;
  let result: ReleaseDeployment | undefined, failure: ReleaseDiagnostic | undefined, stage: ReleaseStage = 'source';
  let closed = true, retained = false;
  const emptyEffects: ReleaseReport['effects'] = { developmentPush: 'not-attempted', releasePush: 'not-attempted' };
  const buildReport = (): ReleaseReport => ({ schemaVersion: 2, command: options.command, ok: failure === undefined,
    startedAt, finishedAt: new Date().toISOString(), steps: session?.steps ?? [], effects: session?.state.effects ?? emptyEffects,
    stage: session?.state.stage ?? stage, ...(source ? { sourceRoot: source.root, candidateSha: source.sha, configPath: source.configPath, configSha256: source.configSha256 } : {}),
    ...(slot ? { slotId: slot.slotId, runId: slot.runId, executionRoot: slot.paths.checkoutRoot } : {}),
    ...(session ? { budget: session.budget.summary(), processes: { status: closed ? 'closed' : 'unknown', knownCount: new Set(session.state.processes.flatMap(command => [...command.descendants, ...(command.identity ? [command.identity] : [])]).map(identity => `${String(identity.pid)}:${identity.startToken}`)).size } } : {}),
    ...(result ? { deployment: result } : {}), ...(failure ? { error: failure } : {}),
    ...(slot && source ? { recovery: { candidateSha: source.sha, reportPath: resolve(slot.paths.slotRoot, options.command === 'publish' ? 'latest-publish.json' : 'latest-check.json'),
      nextCommand: recoveryCommand(retained || !closed || Object.values(session?.state.effects ?? emptyEffects).includes('unknown') ? 'recover' : options.command === 'publish' && ['pushed', 'already-current'].includes(session?.state.effects.releasePush ?? '') ? 'verify' : options.command, source) } } : {}) });
  try {
    assertActive(options.signal);
    if (options.config !== undefined) throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'COMMITTED_CONFIG_REQUIRED' });
    if (!['check', 'publish'].includes(options.command)) throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'MANAGED_RECEIPT_REQUIRED' });
    const entry = await readConfig(resolve(options.cwd, options.configPath ?? 'release.config.json'));
    const original = new Execution(options.cwd, entry, options.signal, []);
    source = await freezeManagedSource(options.cwd, options.configPath ?? 'release.config.json', original);
    await inspectCommitTree(source, original);
    stage = 'admission'; slot = await openManagedSlot(source, original);
    session = await createManagedSession(slot, options.command === 'publish' ? 'publish' : 'check', options.signal);
    const currentSession = session, frozen = source;
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
      mutationGuard: async () => { await assertFrozen(); await currentSession.assertClosed(); await currentSession.budget.sample(); await currentSession.slot.lock.assertOwned(); },
      stage: async value => { currentSession.state.stage = value; await currentSession.persist(); },
      checkpoint: async pending => { if (pending) currentSession.state.pendingPush = pending; else delete currentSession.state.pendingPush; await currentSession.persist(); } }, options.command === 'publish' ? 'publish' : 'check');
    await assertFrozen(); await session.assertClosed(); await session.budget.sample(); session.state.stage = 'complete';
  } catch (error) { failure = diagnostic(error); }
  if (session) {
    try { await session.assertClosed(); } catch { closed = false; }
    retained = !closed || !!session.state.pendingPush || Object.values(session.state.effects).includes('unknown');
    session.state.status = retained ? 'unknown' : 'closed';
    try {
      await session.persist();
      await session.slot.store.writeReceipt(options.command === 'publish' ? 'publish' : 'check', { schemaVersion: 2, slotId: session.slot.slotId, source: session.slot.source, report: buildReport() });
    } catch (error) { failure ??= diagnostic(error); retained = true; }
  }
  if (slot && !retained) { try { await slot.lock.release(); } catch (error) { failure = diagnostic(error); retained = true; } }
  return buildReport();
}
