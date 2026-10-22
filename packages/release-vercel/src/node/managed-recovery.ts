import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FileIdentity, FrozenSource, ManagedAnchor, ManagedPaths, ManagedReceipt, ManagedSession, ManagedSlot, ManagedState } from './release-context.js';
import { assertActive, record, ReleaseError } from './errors.js';
import { assertPathChain, pathExists, readBoundedJson, within } from './managed-io.js';
import { assertManagedPaths } from './managed-paths.js';
import { createManagedStateStore, parseManagedReceipt, parseManagedState } from './managed-state.js';
import { validateReleaseConfig } from './config.js';
import { Execution } from './execution.js';
import { assertRepository, normalizeRepository, remoteRefs } from './git.js';
import { configDigest, readCommittedConfig, relativeConfigPath } from './source.js';
import { identityReader } from './process-identities.js';
import type { ReleaseBudget, ReleaseDeployment, ReleaseDiagnostic, ReleaseRecoveryObservation, ReleaseRefRelation, ReleaseReport, ReleaseStage, RunReleaseOptions } from '../contracts.js';
import { diagnostic } from './workspace-release.js';
import { createTransport, VercelVerification } from './vercel.js';
import { recoveryCommand } from './release-commands.js';
import { claimManagedRecovery } from './managed-recovery-lock.js';
import { BudgetMonitor } from './managed-budget.js';
import { openManagedSlot } from './managed-paths.js';
import { createManagedSession } from './managed-process.js';
import { assertCheckoutFrozen } from './managed-checkout.js';
import { publishCandidate } from './publication.js';
import { hasVerifiedManagedClosure } from './managed-closure.js';

export async function classifyRemoteRef(execution: Execution, sha: string, ref: string): Promise<ReleaseRefRelation> {
  if (sha === ref) return 'candidate';
  const ancestor = async (a: string, b: string): Promise<boolean | undefined> => {
    try { await execution.git(['merge-base', '--is-ancestor', a, b]); return true; }
    catch (error) { if (error instanceof ReleaseError && error.code === 'GIT_FAILED') return error.details.exitCode === 1 ? false : undefined; throw error; }
  };
  const before = await ancestor(ref, sha); if (before === undefined) return 'unknown'; if (before) return 'before';
  const after = await ancestor(sha, ref); return after === undefined ? 'unknown' : after ? 'after' : 'diverged';
}
interface ReceiptOutcome {
  readonly startedAt: string; readonly source?: FrozenSource; readonly location?: ManagedLocation; readonly runId?: string;
  readonly stage: ReleaseStage; readonly effects: ReleaseReport['effects']; readonly steps: ReleaseReport['steps']; readonly failure?: ReleaseDiagnostic;
  readonly observation?: RecoveryObservation; readonly refs?: ReleaseRecoveryObservation; readonly deployment?: ReleaseDeployment; readonly budget?: ReleaseBudget;
  readonly next?: string; readonly kind?: 'publish' | 'check';
}
function receiptReport(options: RunReleaseOptions, outcome: ReceiptOutcome): ReleaseReport {
  const { source, location } = outcome;
  return { schemaVersion: 2, command: options.command, ok: outcome.failure === undefined, startedAt: outcome.startedAt, finishedAt: new Date().toISOString(),
    stage: outcome.stage, steps: outcome.steps, effects: { ...outcome.effects }, ...(outcome.runId ? { runId: outcome.runId } : {}),
    ...(source && location ? { sourceRoot: source.root, executionRoot: location.paths.checkoutRoot, slotId: location.anchor.slotId, candidateSha: source.sha, configSha256: source.configSha256, configPath: source.configPath,
      recovery: { candidateSha: source.sha, reportPath: resolve(location.paths.slotRoot, `latest-${outcome.kind ?? 'publish'}.json`), nextCommand: recoveryCommand(outcome.next ?? 'verify', source), ...(outcome.refs ? { observation: outcome.refs } : {}) } } : {}),
    ...(outcome.observation ? { processes: { status: outcome.observation.processes, knownCount: outcome.observation.knownCount } } : {}),
    ...(outcome.budget ? { budget: outcome.budget } : {}), ...(outcome.deployment ? { deployment: outcome.deployment } : {}), ...(outcome.failure ? { error: outcome.failure } : {}) };
}
async function observeRefs(execution: Execution, source: FrozenSource, observation: RecoveryObservation): Promise<ReleaseRecoveryObservation> {
  const refs = await remoteRefs(execution, source.config);
  const development = refs[source.config.git.developmentBranch] ?? '', release = refs[source.config.git.releaseBranch] ?? '';
  return { owner: observation.owner, processes: observation.processes, observedAt: new Date().toISOString(),
    developmentRef: { sha: development, relation: await classifyRemoteRef(execution, source.sha, development) },
    releaseRef: { sha: release, relation: await classifyRemoteRef(execution, source.sha, release) } };
}
async function recoverManagedPublication(options: RunReleaseOptions): Promise<ReleaseReport> {
  const startedAt = new Date().toISOString();
  let location: ManagedLocation | undefined, source: FrozenSource | undefined, state: ManagedState | undefined;
  let recovery: Awaited<ReturnType<typeof claimManagedRecovery>> | undefined, observation: RecoveryObservation | undefined, refs: ReleaseRecoveryObservation | undefined;
  let budget: BudgetMonitor | undefined, deployment: ReleaseDeployment | undefined, failure: ReleaseDiagnostic | undefined;
  let effects: ReleaseReport['effects'] = { developmentPush: 'not-attempted', releasePush: 'not-attempted' };
  try {
    assertActive(options.signal);
    if (options.config !== undefined) throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'COMMITTED_CONFIG_REQUIRED' });
    location = await readManagedLocation(options.cwd, options.configPath ?? 'release.config.json');
    const value = await readBoundedJson(location.paths.statePath); source = frozenSource(record(value).source, location);
    state = parseManagedState(value, source, location.anchor.slotId); effects = { ...state.effects };
    await assertHistoricalSource(source, options.signal);
    recovery = await claimManagedRecovery(location.paths, state, options.signal);
    observation = await inspectManagedRecovery(state, location.paths, options.signal);
    if (source.config.source.mode !== 'managed-commit') throw new ReleaseError('SOURCE_UNSUPPORTED');
    budget = new BudgetMonitor(location.paths, source.config.source); await budget.sample();
    const execution = new Execution(source.root, source.config, options.signal, []);
    refs = await observeRefs(execution, source, observation);
    const verify = new VercelVerification(source.config, options.transport ?? createTransport(execution), options.signal);
    await verify.project(); deployment = await verify.find(source.sha);
    if (observation.owner !== 'inactive') throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'OWNER_NOT_INACTIVE', owner: observation.owner });
    if (observation.processes !== 'closed') throw new ReleaseError('PROCESS_STATE_UNKNOWN', { reason: 'CLOSURE_UNPROVEN', processes: observation.processes });
    for (const [effect, ref] of [['developmentPush', refs.developmentRef], ['releasePush', refs.releaseRef]] as const) {
      if (state.effects[effect] !== 'unknown' && state.pendingPush !== effect) continue;
      if (!ref || !['candidate', 'before'].includes(ref.relation)) throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'REMOTE_NOT_RESUMABLE', effect, relation: ref?.relation, sha: ref?.sha });
      effects[effect] = ref.relation === 'candidate' ? 'already-current' : 'not-current';
    }
    await budget.sample();
    if (recovery.oldLock) {
      const oldState = state, oldLocation = location, oldLock = recovery.oldLock, claim = recovery.claim;
      const frozen = source;
      const guard = async () => { await assertHistoricalSource(frozen, options.signal); await assertManagedPaths(oldLocation.paths); await claim.assertOwned(); await oldLock.assertOwned(); };
      const store = createManagedStateStore(location.paths, source, location.anchor.slotId, guard);
      const kind = state.command === 'check' ? 'check' : 'publish';
      if (state.command !== 'verify') {
        const previous = await store.readReceipt(kind);
        if (previous && previous.report.runId === state.runId) {
          await store.writeReceipt(kind, { ...previous, report: { ...previous.report,
            recovery: { candidateSha: source.sha, reportPath: resolve(location.paths.slotRoot, `latest-${kind}.json`), nextCommand: recoveryCommand('publish', source), observation: refs } } });
        } else {
          const interrupted: ReleaseReport = { schemaVersion: 2, command: state.command, ok: false, startedAt, finishedAt: new Date().toISOString(),
            candidateSha: source.sha, configSha256: source.configSha256, sourceRoot: source.root, executionRoot: location.paths.checkoutRoot,
            slotId: state.slotId, runId: state.runId, configPath: source.configPath, stage: state.stage, steps: [], effects: { ...state.effects },
            error: { code: 'RECOVERY_REQUIRED', details: { reason: 'RECOVERED_INTERRUPTED_RUN' } }, recovery: { candidateSha: source.sha,
              reportPath: resolve(location.paths.slotRoot, `latest-${kind}.json`), nextCommand: recoveryCommand('publish', source), observation: refs } };
          await store.writeReceipt(kind, { schemaVersion: 2, slotId: state.slotId, source, report: interrupted });
        }
      }
      oldState.effects = effects; delete oldState.pendingPush; oldState.status = 'closed'; await store.writeState(oldState);
      // 旧运行的关键结果全部持久化后，才精确释放原锁；恢复声明仍阻止新运行进入。
      await oldLock.release();
    }
  } catch (error) { failure = diagnostic(error); }
  finally { if (recovery) { try { await recovery.claim.release(); } catch (error) { failure = diagnostic(error); } } }
  return receiptReport(options, { startedAt, stage: failure ? 'recover' : 'complete', steps: [], effects,
    ...(source ? { source } : {}), ...(location ? { location } : {}), ...(state ? { runId: state.runId, kind: state.command === 'check' ? 'check' : 'publish' } : {}),
    ...(observation ? { observation } : {}), ...(refs ? { refs } : {}), ...(budget ? { budget: budget.summary() } : {}), ...(deployment ? { deployment } : {}), ...(failure ? { failure } : {}),
    next: failure ? 'recover' : effects.releasePush === 'pushed' || effects.releasePush === 'already-current' ? 'verify' : 'publish' });
}
async function runManagedVerification(options: RunReleaseOptions): Promise<ReleaseReport> {
  const startedAt = new Date().toISOString();
  let selected: Awaited<ReturnType<typeof loadManagedPublication>> | undefined, slot: ManagedSlot | undefined, session: ManagedSession | undefined;
  let failure: ReleaseDiagnostic | undefined, deployment: ReleaseDeployment | undefined, closed = true;
  try {
    if (options.config !== undefined) throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'COMMITTED_CONFIG_REQUIRED' });
    selected = await loadManagedPublication(options.cwd, options.configPath ?? 'release.config.json', options.sha, options.signal);
    const { source } = selected.receipt;
    if (!await pathExists(resolve(selected.location.paths.checkoutRoot, '.git'))) throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'CHECKOUT_MISSING' });
    const original = new Execution(source.root, source.config, options.signal, []);
    slot = await openManagedSlot(source, original); session = await createManagedSession(slot, 'verify', options.signal);
    const current = session;
    const assertFrozen = async () => { await assertHistoricalSource(source, options.signal); await assertCheckoutFrozen(current); };
    await assertFrozen();
    deployment = await publishCandidate({ execution: session.execution, config: source.config, sha: source.sha, signal: options.signal, transport: options.transport,
      effects: session.state.effects, assertFrozen, mutationGuard: async () => { throw new ReleaseError('SOURCE_UNSUPPORTED'); },
      stage: async stage => { current.state.stage = stage; await current.persist(); }, checkpoint: async () => { throw new ReleaseError('SOURCE_UNSUPPORTED'); } }, 'verify');
    await session.assertClosed(); await session.budget.sample(); session.state.stage = 'complete';
  } catch (error) { failure = diagnostic(error); }
  if (session) {
    try { await session.assertClosed(); } catch { closed = false; }
    session.state.status = closed ? 'closed' : 'unknown';
    try { await session.persist(); } catch (error) { failure ??= diagnostic(error); closed = false; }
  }
  if (slot && closed) { try { await slot.lock.release(); } catch (error) { failure = diagnostic(error); closed = false; } }
  return receiptReport(options, { startedAt, stage: session?.state.stage ?? 'source', steps: session?.steps ?? [], effects: session?.state.effects ?? { developmentPush: 'not-attempted', releasePush: 'not-attempted' },
    ...(selected ? { source: selected.receipt.source, location: selected.location, ...(session ? { runId: session.state.runId } : {}) } : {}),
    ...(session ? { observation: { owner: closed ? 'inactive' : 'unknown', processes: closed ? 'closed' : 'unknown', knownCount: new Set(session.state.processes.flatMap(command => [...command.descendants, ...(command.identity ? [command.identity] : [])]).map(identity => `${String(identity.pid)}:${identity.startToken}`)).size }, budget: session.budget.summary() } : {}),
    ...(deployment ? { deployment } : {}), ...(failure ? { failure } : {}), next: closed ? 'verify' : 'recover' });
}

export async function runManagedReceiptCommand(options: RunReleaseOptions): Promise<ReleaseReport> {
  if (options.command === 'recover') return recoverManagedPublication(options);
  if (options.command === 'verify') return runManagedVerification(options);
  const startedAt = new Date().toISOString();
  let selected: Awaited<ReturnType<typeof loadManagedPublication>> | undefined, observation: RecoveryObservation | undefined;
  let deployment: ReleaseDeployment | undefined, failure: ReleaseDiagnostic | undefined, stage: ReleaseStage = 'source', needsRecovery = false;
  let refs: ReleaseRecoveryObservation | undefined;
  let effects: ReleaseReport['effects'] = { developmentPush: 'not-attempted', releasePush: 'not-attempted' };
  try {
    assertActive(options.signal);
    if (options.config !== undefined) throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'COMMITTED_CONFIG_REQUIRED' });
    if (options.command !== 'status') throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'RECEIPT_COMMAND_PENDING' });
    selected = await loadManagedPublication(options.cwd, options.configPath ?? 'release.config.json', options.sha, options.signal);
    const { receipt, location } = selected, source = receipt.source;
    effects = { ...receipt.report.effects };
    const stateValue = await readBoundedJson(location.paths.statePath);
    if (stateValue === undefined) throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'STATE_MISSING' });
    const stateSource = frozenSource(record(stateValue).source, location);
    await assertHistoricalSource(stateSource, options.signal);
    const state = parseManagedState(stateValue, stateSource, location.anchor.slotId);
    observation = await inspectManagedRecovery(state, location.paths, options.signal);
    needsRecovery = observation.owner !== 'inactive' || observation.processes !== 'closed' || state.status !== 'closed' || !!state.pendingPush || Object.values(state.effects).includes('unknown');
    const execution = new Execution(source.root, source.config, options.signal, []);
    refs = await observeRefs(execution, source, observation);
    const recovered = receipt.report.recovery;
    const proof = recovered?.observation;
    for (const [effect, previous, current] of [['developmentPush', proof?.developmentRef, refs.developmentRef], ['releasePush', proof?.releaseRef, refs.releaseRef]] as const) {
      if (effects[effect] !== 'unknown') continue;
      const witnessed = recovered?.candidateSha === source.sha && proof?.owner === 'inactive' && proof.processes === 'closed'
        && Number.isFinite(Date.parse(proof.observedAt)) && previous && /^[a-f0-9]{40}$/u.test(previous.sha)
        && (previous.relation === 'candidate' ? previous.sha === source.sha : previous.relation === 'before' && previous.sha !== source.sha);
      if (witnessed && current?.relation === 'candidate') effects[effect] = 'already-current';
      else if (witnessed && current?.relation === 'before') effects[effect] = 'not-current';
      else needsRecovery = true;
    }
    stage = 'deployment';
    const verify = new VercelVerification(source.config, options.transport ?? createTransport(execution), options.signal);
    await verify.project(); deployment = await verify.find(source.sha);
    if (observation.processes === 'unknown') throw new ReleaseError('PROCESS_STATE_UNKNOWN');
    if (needsRecovery) throw new ReleaseError('RECOVERY_REQUIRED', { activeRunId: state.runId, owner: observation.owner, processes: observation.processes });
    if (!deployment) throw new ReleaseError('DEPLOYMENT_MISSING');
    stage = 'complete';
  } catch (error) { failure = diagnostic(error); }
  const source = selected?.receipt.source;
  return { schemaVersion: 2, command: options.command, ok: failure === undefined, startedAt, finishedAt: new Date().toISOString(), steps: [], stage,
    effects,
    ...(source && selected ? { sourceRoot: source.root, executionRoot: selected.location.paths.checkoutRoot, configPath: source.configPath,
      slotId: selected.location.anchor.slotId, candidateSha: source.sha, configSha256: source.configSha256,
      ...(selected.receipt.report.runId ? { runId: selected.receipt.report.runId } : {}),
      recovery: { candidateSha: source.sha, reportPath: resolve(selected.location.paths.slotRoot, 'latest-publish.json'), nextCommand: recoveryCommand(needsRecovery ? 'recover' : 'verify', source), ...(refs ? { observation: refs } : {}) } } : {}),
    ...(observation ? { processes: { status: observation.processes, knownCount: observation.knownCount } } : {}),
    ...(deployment ? { deployment } : {}), ...(failure ? { error: failure } : {}) };
}

export interface RecoveryObservation { readonly owner: 'inactive' | 'active' | 'unknown'; readonly processes: 'closed' | 'running' | 'unknown'; readonly knownCount: number }
export async function inspectManagedRecovery(state: ManagedState, paths: ManagedPaths, signal?: AbortSignal, reader = identityReader()): Promise<RecoveryObservation> {
  assertActive(signal); await assertManagedPaths(paths);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.min(30_000, state.source.config.limits.commandMs));
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const identities = new Map(state.processes.flatMap(command => [...command.descendants, ...(command.identity ? [command.identity] : [])]).map(value => [`${String(value.pid)}:${value.startToken}`, value]));
  const unresolved = state.processes.filter(command => !hasVerifiedManagedClosure(command));
  const pendingIdentities = new Map(unresolved.flatMap(command => [...command.descendants, ...(command.identity ? [command.identity] : [])]).map(value => [`${String(value.pid)}:${value.startToken}`, value]));
  let owner: RecoveryObservation['owner'] = 'unknown';
  let unknown = unresolved.length > 0, running = false;
  try {
    try {
      const observed = await reader.readIdentity({ pid: state.coordinator.pid, signal: combined });
      if (observed.status === 'ABSENT') owner = 'inactive';
      else if (observed.identity.startToken === state.coordinator.startToken) owner = await pathExists(paths.lockPath) ? 'active' : state.status === 'closed' ? 'inactive' : 'unknown';
    } catch { assertActive(signal); }
    // 已见证关闭的原实例不能重新出现；复用完整证据，未闭环实例仍逐个核验且不升为 PASS。
    for (const identity of pendingIdentities.values()) {
      if (combined.aborted) { unknown = true; break; }
      try {
        const observed = await reader.readIdentity({ pid: identity.pid, signal: combined });
        if (observed.status === 'FOUND') {
          if (observed.identity.startToken === identity.startToken) running = true; else unknown = true;
        }
      } catch { assertActive(signal); unknown = true; }
    }
    assertActive(signal);
    return { owner, processes: unknown ? 'unknown' : running ? 'running' : 'closed', knownCount: identities.size };
  } finally { clearTimeout(timer); }
}

interface ManagedLocation { readonly root: string; readonly configPath: string; readonly anchor: ManagedAnchor; readonly paths: ManagedPaths; readonly repository: string }
function identity(value: unknown): FileIdentity {
  const item = record(value);
  if (typeof item.dev !== 'string' || !/^\d+$/u.test(item.dev) || typeof item.ino !== 'string' || !/^\d+$/u.test(item.ino)) throw new ReleaseError('SLOT_STATE', { reason: 'FILE_IDENTITY' });
  return { dev: item.dev, ino: item.ino };
}
async function readManagedLocation(cwd: string, configPath: string): Promise<ManagedLocation> {
  const root = await realpath(cwd), path = relativeConfigPath(root, configPath), anchorPath = resolve(root, '.tmp/forge-vercel-release/managed.json');
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
function frozenSource(value: unknown, location: ManagedLocation): FrozenSource {
  const item = record(value), config = validateReleaseConfig(item.config);
  if (item.root !== location.root || item.configPath !== location.configPath || typeof item.sha !== 'string' || !/^[a-f0-9]{40}$/u.test(item.sha)
    || typeof item.configBlobOid !== 'string' || !/^[a-f0-9]{40}$/u.test(item.configBlobOid) || typeof item.configSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.configSha256)
    || typeof item.fetchUrl !== 'string' || config.source.mode !== 'managed-commit' || resolve(location.root, config.source.slotPath) !== location.paths.slotRoot
    || config.git.repository !== location.repository || normalizeRepository(item.fetchUrl, location.root) !== normalizeRepository(config.git.repository, location.root)) throw new ReleaseError('SLOT_STATE', { reason: 'FROZEN_SOURCE' });
  return { root: location.root, configPath: location.configPath, sha: item.sha, config, configBlobOid: item.configBlobOid, configSha256: item.configSha256, fetchUrl: item.fetchUrl };
}
async function assertHistoricalSource(source: FrozenSource, signal?: AbortSignal): Promise<void> {
  const execution = new Execution(source.root, source.config, signal, []);
  try { await assertRepository(execution, source.config); }
  catch { assertActive(signal); throw new ReleaseError('SOURCE_CHANGED', { reason: 'REPOSITORY_IDENTITY' }); }
  const committed = await readCommittedConfig(execution, source.sha, source.configPath);
  if (committed.oid !== source.configBlobOid || await configDigest(committed.config) !== source.configSha256
    || await configDigest(source.config) !== source.configSha256) throw new ReleaseError('SLOT_STATE', { reason: 'CONFIG_BLOB_BINDING' });
}
async function loadManagedPublication(cwd: string, configPath: string, sha?: string, signal?: AbortSignal): Promise<{ receipt: ManagedReceipt; location: ManagedLocation }> {
  assertActive(signal);
  const location = await readManagedLocation(cwd, configPath), selected = location.anchor.latestPublish;
  if (!selected) throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'PUBLISH_RECEIPT_MISSING' });
  if (sha !== undefined && sha !== selected.sha) throw new ReleaseError('RECEIPT_SHA_MISMATCH', { requested: sha, known: selected.sha });
  const value = await readBoundedJson(resolve(location.paths.slotRoot, 'latest-publish.json'));
  const source = frozenSource(record(value).source, location);
  const receipt = parseManagedReceipt(value, source, location.anchor.slotId);
  if (receipt.report.runId !== selected.runId || source.sha !== selected.sha || source.configSha256 !== selected.configSha256 || receipt.report.command !== 'publish') throw new ReleaseError('SLOT_STATE', { reason: 'PUBLICATION_BINDING' });
  await assertHistoricalSource(source, signal);
  return { receipt, location };
}
export async function selectManagedPublication(sourceRoot: string, configPath: string, sha?: string): Promise<ManagedReceipt> {
  return (await loadManagedPublication(sourceRoot, configPath, sha)).receipt;
}
