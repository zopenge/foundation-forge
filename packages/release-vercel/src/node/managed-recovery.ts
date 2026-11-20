import { realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { FileIdentity, FrozenSource, ManagedAnchor, ManagedPaths, ManagedReceipt, ManagedState } from './managed-state-contracts.js';
import type { ManagedSession } from './managed-session-contracts.js';
import type { ManagedSlot } from './managed-slot-contracts.js';
import { assertActive, localLeaseDiagnostic, record, ReleaseError } from './errors.js';
import type { OwnedLock } from './lock.js';
import { assertPathChain, fileIdentity, pathExists, readBoundedJson, sameIdentity, within } from './managed-io.js';
import { assertManagedPaths } from './managed-paths.js';
import { parseManagedReceipt, parseManagedState } from './managed-state.js';
import { validateReleaseConfig } from './config.js';
import { Execution } from './execution.js';
import { createManagedExecution } from './managed-execution.js';
import { normalizeRepository, remoteRefs } from './git.js';
import { assertHistoricalSource, relativeConfigPath } from './source.js';
import { identityReader } from './process-identities.js';
import type { PrebuiltReleaseState, ReleaseBudget, ReleaseCompletionState, ReleaseDeployment, ReleaseDiagnostic, ReleaseRecoveryObservation, ReleaseRefRelation, ReleaseReport, ReleaseStage, RunReleaseOptions } from '../contracts.js';
import type { CandidateMarkerHeaders } from './candidate-marker-auth.js';
import { releaseStages } from '../contracts.js';
import { diagnostic } from './workspace-release.js';
import { createTransport, VercelVerification } from './vercel.js';
import { createPrebuiltTransport, PrebuiltStatusFailure } from './prebuilt-vercel.js';
import { managedPrebuiltContext } from './prebuilt-state.js';
import { observePrebuiltCandidate } from './prebuilt-recovery.js';
import { prebuiltCandidateContext } from './version-alias.js';
import { recordVerifiedAlias } from './prebuilt-resumption.js';
import { recoveryCommand } from './release-commands.js';
import { claimManagedRecovery } from './managed-recovery-lock.js';
import { BudgetMonitor } from './managed-budget.js';
import { openManagedSlot } from './managed-paths.js';
import { createManagedSession } from './managed-process.js';
import { assertCheckoutFrozen } from './managed-checkout.js';
import { publishCandidate } from './publication.js';
import { hasVerifiedManagedStop } from './managed-closure.js';
import { managedCommandIdentities } from './managed-observation.js';
import { discardPreparedState, restoreManagedTerminal } from './managed-terminal.js';
import { archiveManagedDisposition, assertDispositionSnapshot, discardIsolatedCheckout, hasManagedDisposition, readManagedDisposition } from './managed-disposition.js';
import { hasFinalizedRetirement, readRetirementRecord, retirementArchivePath } from './retirement-record.js';
import { assertManagedHistory } from './managed-history.js';
import { runCompletion } from './completion.js';
import { observedCompletionState, parseCompletionState } from './completion-state.js';
import { readCompletionSnapshots } from './completion-history.js';
import { acquireManagedCoordinatorLease, readRetirementHost } from './retirement-host.js';
import { assertMetadataFile, inspectMetadataFile, terminalLimit } from './managed-metadata.js';

export async function classifyRemoteRef(execution: Execution, sha: string, ref: string): Promise<ReleaseRefRelation> {
  if (sha === ref) return 'candidate';
  const ancestor = async (a: string, b: string): Promise<boolean | undefined> => {
    try { await execution.git(['merge-base', '--is-ancestor', a, b]); return true; }
    catch (error) { if (error instanceof ReleaseError && error.code === 'GIT_FAILED') return error.details.exitCode === 1 ? false : undefined; throw error; }
  };
  const before = await ancestor(ref, sha); if (before === undefined) return 'unknown'; if (before) return 'before';
  const after = await ancestor(sha, ref); return after === undefined ? 'unknown' : after ? 'superseded' : 'diverged';
}
interface ReceiptOutcome {
  readonly startedAt: string; readonly source?: FrozenSource; readonly location?: ManagedLocation; readonly runId?: string;
  readonly stage: ReleaseStage; readonly effects: ReleaseReport['effects']; readonly steps: ReleaseReport['steps']; readonly failure?: ReleaseDiagnostic;
  readonly observation?: RecoveryObservation; readonly refs?: ReleaseRecoveryObservation; readonly deployment?: ReleaseDeployment; readonly budget?: ReleaseBudget;
  readonly next?: string; readonly kind?: 'publish' | 'check'; readonly reportExists?: boolean;
  readonly checkoutDiscarded?: true;
  readonly prebuilt?: PrebuiltReleaseState;
  readonly completion?: ReleaseCompletionState;
}
function receiptReport(options: RunReleaseOptions, outcome: ReceiptOutcome): ReleaseReport {
  const { source, location } = outcome;
  const candidateContext = source ? prebuiltCandidateContext(source.config, outcome.prebuilt) : undefined;
  return { schemaVersion: 2, command: options.command, ok: outcome.failure === undefined, startedAt: outcome.startedAt, finishedAt: new Date().toISOString(),
    stage: outcome.stage, steps: outcome.steps, effects: { ...outcome.effects }, ...(outcome.runId ? { runId: outcome.runId } : {}),
    ...(source && location ? { sourceRoot: source.root, executionRoot: location.paths.checkoutRoot, slotId: location.anchor.slotId, candidateSha: source.sha, configSha256: source.configSha256, configPath: source.configPath,
      recovery: { candidateSha: source.sha, reportPath: resolve(location.paths.slotRoot, `latest-${outcome.kind ?? 'publish'}.json`), nextCommand: recoveryCommand(outcome.next ?? 'verify', source), ...(outcome.reportExists === undefined ? {} : { reportExists: outcome.reportExists }), ...(outcome.refs ? { observation: outcome.refs } : {}),
        ...(outcome.checkoutDiscarded ? { checkoutDiscarded: true } : {}) } } : {}),
    ...(outcome.observation ? { processes: { status: outcome.observation.processes, knownCount: outcome.observation.knownCount } } : {}),
    ...(outcome.budget ? { budget: outcome.budget } : {}), ...(outcome.prebuilt ? { prebuilt: outcome.prebuilt } : {}),
    ...(outcome.completion ? { completion: outcome.completion } : {}),
    ...(candidateContext ? { candidateContext } : {}),
    ...(outcome.deployment ? { deployment: outcome.deployment } : {}), ...(outcome.failure ? { error: outcome.failure } : {}) };
}
export async function observeRefs(execution: Execution, source: FrozenSource, observation: RecoveryObservation): Promise<ReleaseRecoveryObservation> {
  const refs = await remoteRefs(execution, source.config);
  const development = refs[source.config.git.developmentBranch] ?? '', release = refs[source.config.git.releaseBranch] ?? '';
  return { owner: observation.owner, processes: observation.processes, observedAt: new Date().toISOString(),
    developmentRef: { sha: development, relation: await classifyRemoteRef(execution, source.sha, development) },
    releaseRef: { sha: release, relation: await classifyRemoteRef(execution, source.sha, release) } };
}
export async function observeRefsForDisposition(execution: Execution, source: FrozenSource, observation: RecoveryObservation): Promise<ReleaseRecoveryObservation> {
  try { return await observeRefs(execution, source, observation); }
  catch (error) {
    assertActive(execution.signal);
    if (!(error instanceof ReleaseError) || !['GIT_FAILED', 'GIT_DIVERGED', 'COMMAND_TIMEOUT'].includes(error.code)) throw error;
    return { owner: observation.owner, processes: observation.processes, observedAt: new Date().toISOString(),
      developmentRef: { sha: '', relation: 'unknown' }, releaseRef: { sha: '', relation: 'unknown' } };
  }
}

/** 旧失败原样保留；在已释放旧锁的槽位上只读复验精确退役范围。 */
async function observeDrainedRetirement(paths: ManagedPaths, state: ManagedState, signal?: AbortSignal): Promise<RecoveryObservation | undefined> {
  if (await pathExists(paths.lockPath)) return;
  const archive = await readRetirementRecord(retirementArchivePath(paths, state.runId), paths);
  if (archive?.final?.cessation !== 'recorded-empty-drained-scope') return;
  const host = await readRetirementHost(signal);
  if (host.hostId !== state.host.hostId || host.platform !== state.host.platform)
    throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'RECOVERY_HOST_CHANGED' });
  const lease = await acquireManagedCoordinatorLease(paths, host, signal);
  try {
    const guard = async () => {
      await lease.assertOwned(); await assertManagedPaths(paths);
      if (await pathExists(paths.lockPath) || await pathExists(paths.recoveryLockPath)) throw new ReleaseError('LOCKED', { reason: 'RECOVERY_ACTIVE' });
      await assertManagedHistory(paths, state);
      if (!await hasFinalizedRetirement(paths, state)) throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'RETIREMENT_INCOMPLETE' });
    };
    await guard();
    const observed = await inspectManagedRecovery(state, paths, signal, undefined, lease, state.processes.at(-1)?.id);
    if (observed.owner !== 'inactive' || observed.processes !== 'closed')
      throw new ReleaseError('PROCESS_STATE_UNKNOWN', { reason: 'CLOSURE_UNPROVEN', owner: observed.owner, processes: observed.processes });
    await guard();
    return observed;
  } finally { await lease.release(); }
}

async function recoverManagedPublication(options: RunReleaseOptions): Promise<ReleaseReport> {
  const startedAt = new Date().toISOString();
  let location: ManagedLocation | undefined, source: FrozenSource | undefined, state: ManagedState | undefined;
  let recovery: Awaited<ReturnType<typeof claimManagedRecovery>> | undefined, observation: RecoveryObservation | undefined, refs: ReleaseRecoveryObservation | undefined;
  let budget: BudgetMonitor | undefined, failure: ReleaseDiagnostic | undefined;
  let discarded = false;
  let effects: ReleaseReport['effects'] = { developmentPush: 'not-attempted', releasePush: 'not-attempted' };
  try {
    assertActive(options.signal);
    if (options.config !== undefined) throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'COMMITTED_CONFIG_REQUIRED' });
    location = await readManagedLocation(options.cwd, options.configPath ?? 'release.config.json');
    const value = await readBoundedJson(location.paths.statePath); source = frozenSource(record(value).source, location);
    state = parseManagedState(value, source, location.anchor.slotId); effects = { ...state.effects };
    if (options.discardCheckout && options.runId !== state.runId)
      throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'CHECKOUT_ISOLATION_RUN_MISMATCH', runId: state.runId });
    await assertHistoricalSource(source, options.signal);
    const paths = location.paths, original = state;
    if (!options.discardCheckout) {
      const retired = await observeDrainedRetirement(paths, state, options.signal);
      if (retired) return receiptReport(options, { startedAt, stage: 'complete', source, location, runId: state.runId, effects,
        steps: [], kind: state.command === 'check' ? 'check' : 'publish', reportExists: true, observation: retired,
        refs: { ...retired, observedAt: new Date().toISOString() }, next: 'publish' });
    }
    const observeRecovery = async (allowReleasedLock: boolean, heldLease?: Pick<OwnedLock, 'assertOwned'>) => {
      const restored = await restoreManagedTerminal(paths, original, { allowReleasedLock, ...(options.signal ? { signal: options.signal } : {}) });
      const observed = await inspectManagedRecovery(restored.state, paths, options.signal, undefined, heldLease);
      observation = observed;
      refs = { owner: observed.owner, processes: observed.processes, observedAt: new Date().toISOString() };
      return { restored, observed };
    };
    const assertStopped = (observed: RecoveryObservation) => {
      if (observed.owner !== 'inactive') throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'OWNER_NOT_INACTIVE', owner: observed.owner });
      if (observed.processes !== 'closed') throw new ReleaseError('PROCESS_STATE_UNKNOWN', { reason: 'CLOSURE_UNPROVEN', processes: observed.processes });
    };
    const requestedIsolation = options.discardCheckout === true || !!(await readManagedDisposition(paths, original.runId))?.checkoutIsolation;
    if (requestedIsolation) {
      // 缺见证时只读取证，在确认旧运行有停止证据前不创建恢复声明。
      const host = await readRetirementHost(options.signal);
      if (host.hostId !== original.host.hostId || host.platform !== original.host.platform)
        throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'RECOVERY_HOST_CHANGED' });
      assertStopped((await observeRecovery(!await pathExists(paths.lockPath))).observed);
      if (!['admission', 'checkout'].includes(state.stage)
        || state.pendingPush || state.completion || Object.values(state.effects).some(effect => effect !== 'not-attempted'))
        throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'CHECKOUT_ISOLATION_EFFECTS' });
      if (!original.checkoutIdentity) throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'CHECKOUT_ISOLATION_IDENTITY_MISSING' });
    }
    recovery = await claimManagedRecovery(location.paths, state, options.signal, requestedIsolation);
    const terminalPath = resolve(paths.slotRoot, 'terminal.json'), terminalFile = await inspectMetadataFile(terminalPath, terminalLimit);
    const { restored, observed } = await observeRecovery(!recovery.oldLock, recovery.claim);
    await assertMetadataFile(terminalPath, terminalFile, terminalLimit);
    if (source.config.source.mode !== 'managed-commit') throw new ReleaseError('SOURCE_UNSUPPORTED');
    const previous = await readManagedDisposition(location.paths, state.runId);
    let isolation = previous?.checkoutIsolation;
    if (options.discardCheckout && !isolation) {
      if (previous) throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'CHECKOUT_ISOLATION_ALREADY_DISPOSED' });
      if (!await pathExists(location.paths.checkoutRoot)) throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'CHECKOUT_MISSING' });
      const expected = state.checkoutIdentity;
      if (!expected || !sameIdentity(await fileIdentity(location.paths.checkoutRoot), expected))
        throw new ReleaseError('SLOT_STATE', { reason: 'CHECKOUT_ISOLATION_CHANGED' });
      isolation = { ...expected, quarantineId: randomUUID() };
    }
    if (!isolation) { budget = new BudgetMonitor(location.paths, source.config.source); await budget.sample(); }
    const execution = createManagedExecution(source.root, source.config, options.signal, []);
    if (!source.config.delivery) refs = await observeRefsForDisposition(execution, source, observed);
    assertStopped(observed);
    await budget?.sample();
    const oldLocation = location, claim = recovery.claim, oldLock = recovery.oldLock, frozen = source;
    const guard = async () => {
      await assertHistoricalSource(frozen, options.signal); await assertManagedPaths(oldLocation.paths);
      await claim.assertOwned(); await oldLock?.assertOwned(); await assertMetadataFile(terminalPath, terminalFile, terminalLimit);
    };
    const archived = await archiveManagedDisposition(location.paths, state, restored.state, guard, refs, false, undefined, isolation);
    await discardPreparedState(location.paths, restored.terminal, async () => { await guard(); await assertDispositionSnapshot(oldLocation.paths, archived, !!oldLock); });
    if (isolation) {
      const assertDiscarded = await discardIsolatedCheckout(location.paths, archived, guard, !!oldLock);
      await assertDiscarded();
      discarded = true;
    }
    // 原始失败和未决副作用均已归档；这里只结束本地占用，不重放远端操作。
    await oldLock?.release();
  } catch (error) { failure = diagnostic(error); }
  finally { if (recovery) { try { await recovery.claim.release(); } catch (error) { failure ??= diagnostic(error); } } }
  let reportExists: boolean | undefined;
  if (location && state) {
    try {
      const raw = record(await readBoundedJson(resolve(location.paths.slotRoot, state.command === 'check' ? 'latest-check.json' : 'latest-publish.json')));
      const latest = record(raw.report);
      reportExists = raw.slotId === state.slotId && latest.candidateSha === state.source.sha && latest.configSha256 === state.source.configSha256
        && (state.command === 'verify' || latest.runId === state.runId);
    } catch { /* 无法确认时省略，而不把路径文本视作证据。 */ }
  }
  return receiptReport(options, { startedAt, stage: failure ? 'recover' : 'complete', steps: [], effects, ...(reportExists === undefined ? {} : { reportExists }),
    ...(source ? { source } : {}), ...(location ? { location } : {}), ...(state ? { runId: state.runId, kind: state.command === 'check' ? 'check' : 'publish' } : {}),
    ...(observation ? { observation } : {}), ...(refs ? { refs } : {}), ...(budget ? { budget: budget.summary() } : {}), ...(failure ? { failure } : {}),
    ...(state?.prebuilt ? { prebuilt: state.prebuilt } : {}),
    ...(state?.completion ? { completion: state.completion } : {}),
    ...(discarded ? { checkoutDiscarded: true } : {}),
    next: failure ? options.discardCheckout && options.runId ? `recover --run-id ${options.runId} --discard-checkout`
      : failure.details.reason === 'CLOSURE_UNPROVEN' && state ? `retire --run-id ${state.runId}` : 'recover'
      : state?.prebuilt ? state.prebuilt.deploymentId ? 'verify' : 'status' : effects.releasePush === 'pushed' || effects.releasePush === 'already-current' ? 'verify' : 'publish' });
}
export async function settleManagedSlot(options: RunReleaseOptions): Promise<void> {
  if (!await pathExists(resolve(options.cwd, 'state/forge-vercel-release/managed.json'))) return;
  const location = await readManagedLocation(options.cwd, options.configPath ?? 'release.config.json');
  const value = await readBoundedJson(location.paths.statePath);
  if (value === undefined) throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'STATE_MISSING' });
  const source = frozenSource(record(value).source, location), state = parseManagedState(value, source, location.anchor.slotId);
  await assertHistoricalSource(source, options.signal);
  if (!await pathExists(location.paths.lockPath) && (await hasManagedDisposition(location.paths, state)
    || await hasFinalizedRetirement(location.paths, state)
    || (state.status === 'closed' && !state.pendingPush && !Object.values(state.effects).includes('unknown') && state.processes.every(hasVerifiedManagedStop)))) return;
  const recovered = await recoverManagedPublication({ ...options, command: 'recover' });
  if (!recovered.ok) {
    const error = recovered.error;
    const active = state.coordinatorLease === 'native-directory' && error?.code === 'LOCKED' && error.details.reason === 'RETIREMENT_ACTIVE';
    throw new ReleaseError(active ? 'RECOVERY_REQUIRED' : error?.code ?? 'RECOVERY_REQUIRED', {
      ...(active ? { reason: 'OWNER_NOT_INACTIVE', owner: 'active' } : error?.details),
      runId: state.runId, ...(recovered.recovery?.nextCommand ? { nextCommand: recovered.recovery.nextCommand } : {}) });
  }
}
async function runManagedVerification(options: RunReleaseOptions, candidateMarkerHeaders?: CandidateMarkerHeaders): Promise<ReleaseReport> {
  const startedAt = new Date().toISOString();
  let selected: Awaited<ReturnType<typeof loadManagedPublication>> | undefined, slot: ManagedSlot | undefined, session: ManagedSession | undefined;
  let failure: ReleaseDiagnostic | undefined, deployment: ReleaseDeployment | undefined, closed = true, retained = false;
  const report = () => receiptReport(options, { startedAt, stage: session?.state.stage ?? 'source', steps: session?.steps ?? [],
    effects: session?.state.effects ?? (selected?.receipt.report.completion ? selected.receipt.report.effects : { developmentPush: 'not-attempted', releasePush: 'not-attempted' }),
    ...(selected ? { source: selected.receipt.source, location: selected.location, ...(selected.reportExists ? {} : { reportExists: false }),
      ...(session ? { runId: session.state.runId } : {}) } : {}),
    ...(session ? { observation: { owner: closed && !retained ? 'inactive' : 'unknown', processes: closed ? 'closed' : 'unknown', knownCount: new Set(session.state.processes.flatMap(managedCommandIdentities).map(identity => `${String(identity.pid)}:${identity.startToken}`)).size }, budget: session.budget.summary() } : {}),
    ...(session?.state.prebuilt ? { prebuilt: session.state.prebuilt } : {}),
    ...(session?.state.completion ? { completion: session.state.completion } : {}),
    ...(!session && selected?.receipt.report.completion ? { completion: selected.receipt.report.completion,
      ...(selected.receipt.report.prebuilt ? { prebuilt: selected.receipt.report.prebuilt } : {}) } : {}),
    ...(deployment ? { deployment } : {}), ...(failure ? { failure } : {}),
    next: closed && !retained ? session?.state.completion && session.state.completion.status !== 'completed' ? 'verify --retry-completion' : 'verify' : 'recover' });
  try {
    if (options.config !== undefined) throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'COMMITTED_CONFIG_REQUIRED' });
    selected = await loadManagedPublication(options.cwd, options.configPath ?? 'release.config.json', options.sha, options.signal);
    const { source } = selected.receipt;
    if (options.retryCompletion && !source.config.completion) throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'COMPLETION_NOT_CONFIGURED' });
    if (!await pathExists(resolve(selected.location.paths.checkoutRoot, '.git'))) throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'CHECKOUT_MISSING' });
    const original = createManagedExecution(source.root, source.config, options.signal, []);
    await settleManagedSlot(options); slot = await openManagedSlot(source, original, 'verify'); session = await createManagedSession(slot, 'verify', options.signal);
    const current = session;
    if (source.config.delivery && selected.receipt.report.prebuilt) {
      session.state.prebuilt = structuredClone(selected.receipt.report.prebuilt);
      session.state.effects.deploymentCreate = session.state.prebuilt.createEffect;
      session.state.effects.deploymentPromote = session.state.prebuilt.promoteEffect;
      if (session.state.prebuilt.versionAlias) session.state.effects.versionAliasAssign = session.state.prebuilt.versionAlias.effect;
      await session.persist();
    }
    const assertFrozen = async () => { await assertHistoricalSource(source, options.signal); await assertCheckoutFrozen(current); };
    await assertFrozen();
    deployment = await publishCandidate({ execution: session.execution, config: source.config, sha: source.sha, signal: options.signal, transport: options.transport, buildInfoHttp: options.buildInfoHttp,
      effects: session.state.effects, prebuilt: managedPrebuiltContext(session), assertFrozen, candidateMarkerHeaders, vercelApiHttp: options.vercelApiHttp,
      mutationGuard: async () => { throw new ReleaseError('SOURCE_UNSUPPORTED'); },
      stage: async stage => { current.state.stage = stage; await current.persist(); }, checkpoint: async () => { throw new ReleaseError('SOURCE_UNSUPPORTED'); } }, 'verify');
    await runCompletion(session, options, assertFrozen, candidateMarkerHeaders);
    await recordVerifiedAlias(session, selected.receipt, options.transport, options.buildInfoHttp, candidateMarkerHeaders, options.vercelApiHttp);
    await session.assertClosed(); await session.budget.sample(); session.state.stage = 'complete';
  } catch (error) { failure = diagnostic(error); }
  retained = failure?.code === 'BUDGET_UNKNOWN' && failure.details.reason === 'OBSERVATION_DEADLINE';
  if (session) {
    try { await session.assertStopped(); } catch { closed = false; }
    session.state.status = closed ? 'closed' : 'unknown';
    if (!retained) try {
      await session.persist();
      if (closed) {
        const completed = session; await completed.assertStopped();
        await archiveManagedDisposition(completed.slot.paths, completed.state, completed.state, () => completed.slot.lock.assertOwned(), undefined, false, report());
      }
    } catch (error) { failure ??= diagnostic(error); closed = false; }
  }
  if (slot && closed && !retained) { try { await slot.lock.release(); } catch (error) { failure ??= diagnostic(error); retained = true; } }
  try { await slot?.coordinatorLease?.release(); } catch (error) { failure ??= diagnostic(error); retained = true; }
  return report();
}

export async function runManagedReceiptCommand(options: RunReleaseOptions, candidateMarkerHeaders?: CandidateMarkerHeaders): Promise<ReleaseReport> {
  if (options.command === 'recover') return recoverManagedPublication(options);
  if (options.command === 'verify') return runManagedVerification(options, candidateMarkerHeaders);
  const startedAt = new Date().toISOString();
  let selected: Awaited<ReturnType<typeof loadManagedPublication>> | undefined, observation: RecoveryObservation | undefined;
  let deployment: ReleaseDeployment | undefined, failure: ReleaseDiagnostic | undefined, stage: ReleaseStage = 'source', needsRecovery = false;
  let refs: ReleaseRecoveryObservation | undefined;
  let effects: ReleaseReport['effects'] = { developmentPush: 'not-attempted', releasePush: 'not-attempted' };
  let prebuilt: PrebuiltReleaseState | undefined;
  let completion: ReleaseCompletionState | undefined;
  try {
    assertActive(options.signal);
    if (options.config !== undefined) throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'COMMITTED_CONFIG_REQUIRED' });
    if (options.command !== 'status') throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'RECEIPT_COMMAND_PENDING' });
    selected = await loadManagedPublication(options.cwd, options.configPath ?? 'release.config.json', options.sha, options.signal, true);
    const { receipt, location } = selected, source = receipt.source;
    effects = { ...receipt.report.effects };
    const stateValue = await readBoundedJson(location.paths.statePath);
    if (stateValue === undefined) throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'STATE_MISSING' });
    const stateSource = frozenSource(record(stateValue).source, location);
    await assertHistoricalSource(stateSource, options.signal);
    const state = parseManagedState(stateValue, stateSource, location.anchor.slotId);
    await assertManagedHistory(location.paths, state);
    const restored = await restoreManagedTerminal(location.paths, state, { allowReleasedLock: !await pathExists(location.paths.lockPath), ...(options.signal ? { signal: options.signal } : {}) });
    observation = await inspectManagedRecovery(restored.state, location.paths, options.signal);
    if (source.config.completion) {
      const snapshots = await readCompletionSnapshots(location.paths, location.anchor.slotId, state, options.signal);
      const matches = snapshots.filter(snapshot => snapshot.origin.source.sha === source.sha && snapshot.origin.source.configSha256 === source.configSha256
        && (!receipt.report.completion || snapshot.completion.publicationRunId === receipt.report.completion.publicationRunId));
      if (matches.length > 1) throw new ReleaseError('SLOT_STATE', { reason: 'COMPLETION_BINDING_AMBIGUOUS' });
      const snapshot = matches[0];
      completion = observedCompletionState(snapshot?.completion, state.runId, observation.owner);
      parseCompletionState(completion, source, receipt.report.prebuilt);
      if (completion) prebuilt = snapshot?.current.prebuilt ?? receipt.report.prebuilt;
    }
    const locallyReady = await hasManagedDisposition(location.paths, state);
    needsRecovery = observation.owner !== 'inactive' || observation.processes !== 'closed' || (state.status !== 'closed' && !locallyReady);
    const execution = createManagedExecution(source.root, source.config, options.signal, []);
    refs = source.config.delivery ? { owner: observation.owner, processes: observation.processes, observedAt: new Date().toISOString() }
      : await observeRefs(execution, source, observation);
    const published = receipt.report.runId ? await readManagedDisposition(location.paths, receipt.report.runId) : undefined;
    for (const [effect, current] of [['developmentPush', refs.developmentRef], ['releasePush', refs.releaseRef]] as const) {
      if (effects[effect] !== 'unknown') continue;
      if (!published || published.stopped.source.sha !== source.sha || !current || !['candidate', 'superseded'].includes(current.relation)) needsRecovery = true;
    }
    stage = 'deployment';
    if (source.config.delivery) {
      const found = await observePrebuiltCandidate(source.config, prebuilt ?? receipt.report.prebuilt,
        createPrebuiltTransport(execution, source.config, false, options.buildInfoHttp, options.transport, candidateMarkerHeaders, options.vercelApiHttp), options.signal, 'status');
      deployment = found.deployment; prebuilt = found.observed;
      effects.deploymentCreate = prebuilt.createEffect; effects.deploymentPromote = prebuilt.promoteEffect;
      if (prebuilt.versionAlias) effects.versionAliasAssign = prebuilt.versionAlias.effect;
    } else {
      const verify = new VercelVerification(source.config, options.transport ?? createTransport(execution, options.buildInfoHttp), options.signal);
      await verify.project(); deployment = await verify.find(source.sha);
    }
    if (observation.processes === 'unknown') throw new ReleaseError('PROCESS_STATE_UNKNOWN');
    if (needsRecovery) throw new ReleaseError('RECOVERY_REQUIRED', { activeRunId: state.runId, owner: observation.owner, processes: observation.processes });
    if (!deployment) throw new ReleaseError('DEPLOYMENT_MISSING');
    if (completion && completion.status !== 'completed') {
      stage = 'completion'; throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'COMPLETION_PENDING' });
    }
    stage = 'complete';
  } catch (error) {
    failure = diagnostic(error);
    if (error instanceof PrebuiltStatusFailure) {
      deployment = error.deployment;
      prebuilt = selected?.receipt.report.prebuilt;
      // 缺收据时的恢复描述只供观察，不能作为原 publish 阶段证明。
      const recordedStage = selected?.reportExists ? selected.receipt.report.stage : undefined;
      const publicationStage = releaseStages.find(stage => stage === recordedStage);
      if (publicationStage !== undefined) failure = { code: failure.code, details: { ...failure.details, publicationStage } };
    }
  }
  const source = selected?.receipt.source;
  const candidateContext = source ? prebuiltCandidateContext(source.config, prebuilt) : undefined;
  return { schemaVersion: 2, command: options.command, ok: failure === undefined, startedAt, finishedAt: new Date().toISOString(), steps: [], stage,
    effects, ...(prebuilt ? { prebuilt } : {}),
    ...(completion ? { completion } : {}),
    ...(candidateContext ? { candidateContext } : {}),
    ...(source && selected ? { sourceRoot: source.root, executionRoot: selected.location.paths.checkoutRoot, configPath: source.configPath,
      slotId: selected.location.anchor.slotId, candidateSha: source.sha, configSha256: source.configSha256,
      ...(selected.receipt.report.runId ? { runId: selected.receipt.report.runId } : {}),
      recovery: { candidateSha: source.sha, reportPath: resolve(selected.location.paths.slotRoot, 'latest-publish.json'),
        nextCommand: recoveryCommand(needsRecovery ? 'recover' : completion && completion.status !== 'completed' ? 'verify --retry-completion' : 'verify', source),
        ...(selected.reportExists ? {} : { reportExists: false }),
        ...(refs ? { observation: refs } : {}) } } : {}),
    ...(observation ? { processes: { status: observation.processes, knownCount: observation.knownCount } } : {}),
    ...(deployment ? { deployment } : {}), ...(failure ? { error: failure } : {}) };
}

export interface RecoveryObservation { readonly owner: 'inactive' | 'active' | 'unknown'; readonly processes: 'closed' | 'running' | 'unknown'; readonly knownCount: number }
export async function inspectManagedRecovery(state: ManagedState, paths: ManagedPaths, signal?: AbortSignal, reader = identityReader(),
  heldLease?: Pick<OwnedLock, 'assertOwned'>, recordedDrainedCommandId?: string): Promise<RecoveryObservation> {
  assertActive(signal); await assertManagedPaths(paths);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.min(30_000, state.source.config.limits.commandMs));
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const identities = new Map(state.processes.flatMap(managedCommandIdentities).map(value => [`${String(value.pid)}:${value.startToken}`, value]));
  const unresolved = state.processes.filter(command => !hasVerifiedManagedStop(command));
  const pendingIdentities = new Map(unresolved.flatMap(managedCommandIdentities).map(value => [`${String(value.pid)}:${value.startToken}`, value]));
  let owner: RecoveryObservation['owner'] = 'unknown';
  // 显式退役已核过收据及 Job 空集合；只有该命令可由本次身份观测补足停止事实。
  const observingDrained = unresolved.length === 1 && unresolved[0]?.id === recordedDrainedCommandId;
  let unknown = unresolved.length > 0 && !observingDrained, running = false;
  try {
    try {
      if (state.coordinatorLease === 'native-directory') {
        // 该协议跟踪单次 SDK 调用，Node 宿主可以继续为其他调用服务。
        if (heldLease) { await heldLease.assertOwned(); owner = 'inactive'; }
        else {
          const host = await readRetirementHost(combined);
          if (host.hostId === state.host.hostId && host.platform === state.host.platform) {
            const probe = await acquireManagedCoordinatorLease(paths, host, combined);
            await probe.release(); owner = 'inactive';
          }
        }
      } else {
        const observed = await reader.readIdentity({ pid: state.coordinator.pid, signal: combined });
        if (observed.status === 'ABSENT') owner = 'inactive';
        else if (observed.identity.startToken === state.coordinator.startToken) owner = await pathExists(paths.lockPath) ? 'active' : state.status === 'closed' || await hasManagedDisposition(paths, state) ? 'inactive' : 'unknown';
        else owner = 'inactive';
      }
    } catch (error) { assertActive(signal); if (localLeaseDiagnostic(error)?.code === 'LOCKED') owner = 'active'; }
    // 已见证关闭的原实例不能重新出现；复用完整证据，未闭环实例仍逐个核验且不升为 PASS。
    for (const identity of pendingIdentities.values()) {
      if (combined.aborted) { unknown = true; break; }
      try {
        const observed = await reader.readIdentity({ pid: identity.pid, signal: combined });
        if (observed.status === 'FOUND') {
          if (observed.identity.pid !== identity.pid) unknown = true;
          else if (observed.identity.startToken === identity.startToken) running = true;
          else if (!observingDrained) unknown = true;
        }
      } catch { assertActive(signal); unknown = true; }
    }
    assertActive(signal);
    return { owner, processes: unknown ? 'unknown' : running ? 'running' : 'closed', knownCount: identities.size };
  } finally { clearTimeout(timer); }
}

export interface ManagedLocation { readonly root: string; readonly configPath: string; readonly anchor: ManagedAnchor; readonly paths: ManagedPaths; readonly repository: string }
function identity(value: unknown): FileIdentity {
  const item = record(value);
  if (typeof item.dev !== 'string' || !/^\d+$/u.test(item.dev) || typeof item.ino !== 'string' || !/^\d+$/u.test(item.ino)) throw new ReleaseError('SLOT_STATE', { reason: 'FILE_IDENTITY' });
  return { dev: item.dev, ino: item.ino };
}
export async function readManagedLocation(cwd: string, configPath: string): Promise<ManagedLocation> {
  const root = await realpath(cwd), path = relativeConfigPath(root, configPath), anchorPath = resolve(root, 'state/forge-vercel-release/managed.json');
  await assertPathChain(root, anchorPath);
  const value = await readBoundedJson(anchorPath, 65_536);
  if (value === undefined) throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'ANCHOR_MISSING' });
  const item = record(value);
  if (item.schemaVersion !== 2 || item.sourceRoot !== root || item.configPath !== path || typeof item.slotId !== 'string'
    || !/^[a-f0-9-]{36}$/u.test(item.slotId) || typeof item.slotPath !== 'string' || !within(root, item.slotPath) || item.slotPath === root
    || resolve(item.slotPath) !== item.slotPath || within(item.slotPath, anchorPath)) throw new ReleaseError('SLOT_STATE', { reason: 'ANCHOR' });
  const slotRoot = item.slotPath; await assertPathChain(root, slotRoot);
  const owner = record(await readBoundedJson(resolve(slotRoot, 'ownership.json'), 65_536));
  if (owner.schemaVersion !== 2 || owner.slotId !== item.slotId || owner.sourceRoot !== root || owner.configPath !== path || typeof owner.repository !== 'string') throw new ReleaseError('SLOT_STATE', { reason: 'OWNER_BINDING' });
  const latest = item.latestPublish === undefined ? undefined : record(item.latestPublish);
  if (latest && (typeof latest.sha !== 'string' || !/^[a-f0-9]{40}$/u.test(latest.sha) || typeof latest.runId !== 'string'
    || !/^[a-f0-9-]{36}$/u.test(latest.runId) || typeof latest.configSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(latest.configSha256))) throw new ReleaseError('SLOT_STATE', { reason: 'PUBLISH_ANCHOR' });
  const anchor: ManagedAnchor = { schemaVersion: 2, sourceRoot: root, configPath: path, slotId: item.slotId, slotPath: slotRoot,
    ...(latest ? { latestPublish: { sha: String(latest.sha), runId: String(latest.runId), configSha256: String(latest.configSha256) } } : {}) };
  const paths: ManagedPaths = { sourceRoot: root, slotRoot, checkoutRoot: resolve(slotRoot, 'checkout'), anchorPath,
    ownershipPath: resolve(slotRoot, 'ownership.json'), statePath: resolve(slotRoot, 'state.json'), lockPath: resolve(slotRoot, 'run.lock'), recoveryLockPath: resolve(slotRoot, 'recover.lock'),
    sourceIdentity: identity(owner.sourceIdentity), slotIdentity: identity(owner.slotIdentity) };
  await assertManagedPaths(paths);
  return { root, configPath: path, anchor, paths, repository: owner.repository };
}
export function frozenSource(value: unknown, location: ManagedLocation): FrozenSource {
  const item = record(value), config = validateReleaseConfig(item.config);
  if (item.root !== location.root || item.configPath !== location.configPath || typeof item.sha !== 'string' || !/^[a-f0-9]{40}$/u.test(item.sha)
    || typeof item.configBlobOid !== 'string' || !/^[a-f0-9]{40}$/u.test(item.configBlobOid) || typeof item.configSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.configSha256)
    || typeof item.fetchUrl !== 'string' || config.source.mode !== 'managed-commit' || resolve(location.root, config.source.slotPath) !== location.paths.slotRoot
    || config.git.repository !== location.repository || normalizeRepository(item.fetchUrl, location.root) !== normalizeRepository(config.git.repository, location.root)) throw new ReleaseError('SLOT_STATE', { reason: 'FROZEN_SOURCE' });
  return { root: location.root, configPath: location.configPath, sha: item.sha, config, configBlobOid: item.configBlobOid, configSha256: item.configSha256, fetchUrl: item.fetchUrl };
}
/** 缺少正常收据时只读原意图；descriptor 永远是失败，绝不补造原发布成功。 */
async function publicationIntentReceipt(location: ManagedLocation, selected: NonNullable<ManagedAnchor['latestPublish']>, signal: AbortSignal | undefined,
  allowActive: boolean): Promise<ManagedReceipt | undefined> {
  const archive = await readManagedDisposition(location.paths, selected.runId);
  const retired = archive ? undefined : (await readCompletionSnapshots(location.paths, location.anchor.slotId, undefined, signal))
    .flatMap(snapshot => snapshot.ceased).find(state => state.command === 'publish' && state.runId === selected.runId);
  const archived = !!archive || !!retired;
  let state = archive?.stopped ?? retired;
  if (!state) {
    const value = await readBoundedJson(location.paths.statePath);
    if (record(record(record(value).source).config).completion === undefined) return;
    const source = frozenSource(record(value).source, location);
    state = parseManagedState(value, source, location.anchor.slotId);
  }
  if (state.command !== 'publish' || state.runId !== selected.runId) return;
  if (!archive && (!state.source.config.completion || !state.completion || !state.prebuilt)) return;
  const source = frozenSource(state.source, location);
  if (source.sha !== selected.sha || source.configSha256 !== selected.configSha256 || state.slotId !== location.anchor.slotId)
    throw new ReleaseError('SLOT_STATE', { reason: 'COMPLETION_INTENT_IDENTITY' });
  await assertHistoricalSource(source, signal);
  if (!archived && !allowActive) throw new ReleaseError('RECOVERY_REQUIRED', {
    reason: 'COMPLETION_INTENT_NEEDS_RECOVERY', runId: state.runId, nextCommand: recoveryCommand('recover', source) });
  if (archive && !state.processes.every(hasVerifiedManagedStop)) throw new ReleaseError('PROCESS_STATE_UNKNOWN', { reason: 'CLOSURE_UNPROVEN' });
  const observedAt = archive?.recordedAt ?? new Date().toISOString(), candidateContext = prebuiltCandidateContext(source.config, state.prebuilt);
  const report: ReleaseReport = { schemaVersion: 2, command: 'publish', ok: false, startedAt: observedAt, finishedAt: observedAt,
    steps: [], effects: { ...state.effects }, candidateSha: source.sha, configSha256: source.configSha256, runId: state.runId,
    slotId: state.slotId, sourceRoot: source.root, executionRoot: location.paths.checkoutRoot, configPath: source.configPath, stage: state.stage,
    ...(state.prebuilt ? { prebuilt: state.prebuilt } : {}), ...(state.completion ? { completion: state.completion } : {}),
    ...(candidateContext ? { candidateContext } : {}),
    error: { code: 'RECOVERY_REQUIRED', details: { reason: archived ? 'ARCHIVED_PUBLICATION_INTENT' : 'ACTIVE_PUBLICATION_INTENT' } } };
  return parseManagedReceipt({ schemaVersion: 2, slotId: state.slotId, source, report }, source, state.slotId);
}
export async function loadManagedPublication(cwd: string, configPath: string, sha?: string, signal?: AbortSignal,
  allowActiveCompletion = false): Promise<{ receipt: ManagedReceipt; location: ManagedLocation; reportExists: boolean }> {
  assertActive(signal);
  const location = await readManagedLocation(cwd, configPath), selected = location.anchor.latestPublish;
  if (!selected) throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'PUBLISH_RECEIPT_MISSING' });
  if (sha !== undefined && sha !== selected.sha) throw new ReleaseError('RECEIPT_SHA_MISMATCH', { requested: sha, known: selected.sha });
  const value = await readBoundedJson(resolve(location.paths.slotRoot, 'latest-publish.json'));
  if (value === undefined) {
    const intent = await publicationIntentReceipt(location, selected, signal, allowActiveCompletion);
    if (intent) return { receipt: intent, location, reportExists: false };
  }
  const source = frozenSource(record(value).source, location);
  const receipt = parseManagedReceipt(value, source, location.anchor.slotId);
  await assertHistoricalSource(source, signal);
  if (receipt.report.command === 'publish' && receipt.report.runId !== selected.runId) {
    const intent = await publicationIntentReceipt(location, selected, signal, allowActiveCompletion);
    if (intent) return { receipt: intent, location, reportExists: false };
  }
  if (receipt.report.runId !== selected.runId || source.sha !== selected.sha || source.configSha256 !== selected.configSha256 || receipt.report.command !== 'publish') throw new ReleaseError('SLOT_STATE', { reason: 'PUBLICATION_BINDING' });
  return { receipt, location, reportExists: true };
}
export async function selectManagedPublication(sourceRoot: string, configPath: string, sha?: string): Promise<ManagedReceipt> {
  return (await loadManagedPublication(sourceRoot, configPath, sha)).receipt;
}
