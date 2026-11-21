import { mkdir, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { LocalDirectoryLease } from '@openge/forge-process-control-node';
import type { ReleaseDiagnostic, ReleaseRecoveryObservation, ReleaseReport, RunReleaseOptions } from '../contracts.js';
import type { ManagedState } from './managed-state-contracts.js';
import { acquireManagedCoordinatorLease, readRetirementHost, validRetirementHost, type RetirementHost } from './retirement-host.js';
import { frozenSource, inspectManagedRecovery, observeRefsForDisposition, readManagedLocation, type ManagedLocation, type RecoveryObservation } from './managed-recovery.js';
import { assertHistoricalSource } from './source.js';
import { parseManagedState } from './managed-state.js';
import { assertActive, record, ReleaseError } from './errors.js';
import { assertManagedPaths, assertManagementUntracked } from './managed-paths.js';
import { assertPathChain, fileIdentity, pathExists, readBoundedJson, sameIdentity } from './managed-io.js';
import { assertRetirementSnapshot, captureRetirementSnapshot, hasFinalizedRetirement, hasUnresolvedRetirementEffects, readRetirementRecord, retirementArchivePath, retirementCessation, retirementDigest, sealRetirementRecord, writeRetirementJson } from './retirement-record.js';
import type { RetirementRecord } from './retirement-contracts.js';
import { claimRetirement } from './retirement-claim.js';
import { diagnostic } from './workspace-release.js';
import { createManagedExecution } from './managed-execution.js';
import { recoveryCommand } from './release-commands.js';
import { identityReader } from './process-identities.js';
import { managedCommandIdentities } from './managed-observation.js';
import { assertManagedHistory } from './managed-history.js';
import { restoreManagedTerminal } from './managed-terminal.js';
import { hasPendingCheckoutIsolation, readManagedDisposition } from './managed-disposition.js';
import { drainedAcceptanceCandidate } from './drained-retirement.js';
import { assertRecordedPrebuiltArtifact } from './prebuilt-artifact.js';

/** 宿主 reader 是内部 OS 观测边界；公开 API 不接受调用方注入身份或停止证明。 */
export async function runManagedRetirement(options: RunReleaseOptions, hostReader: (signal?: AbortSignal) => Promise<RetirementHost> = readRetirementHost): Promise<ReleaseReport> {
  const startedAt = new Date().toISOString();
  let location: ManagedLocation | undefined, state: ManagedState | undefined, evidence: RetirementRecord | undefined;
  let lease: LocalDirectoryLease | undefined, claim: Awaited<ReturnType<typeof claimRetirement>> | undefined;
  let processes: RecoveryObservation['processes'] = 'unknown';
  let failure: ReleaseDiagnostic | undefined, retirement: ReleaseReport['retirement'], archivePath: string | undefined;
  try {
    assertActive(options.signal);
    if (options.config !== undefined || options.command !== 'retire' || !options.runId || !/^[a-f0-9-]{36}$/u.test(options.runId)) throw new ReleaseError('ARGUMENT_INVALID');
    location = await readManagedLocation(options.cwd, options.configPath ?? 'release.config.json');
    const value = await readBoundedJson(location.paths.statePath), source = frozenSource(record(value).source, location);
    state = parseManagedState(value, source, location.anchor.slotId);
    if (state.runId !== options.runId) throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'RETIREMENT_RUN_MISMATCH', runId: state.runId });
    await assertHistoricalSource(source, options.signal);
    const host = await hostReader(options.signal);
    if (!validRetirementHost(host)) throw new ReleaseError('PROCESS_STATE_UNKNOWN', { reason: 'HOST_OBSERVATION_UNKNOWN' });
    if (state.host.hostId !== host.hostId || state.host.platform !== host.platform) throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'RETIREMENT_HOST_CHANGED' });
    lease = await acquireManagedCoordinatorLease(location.paths, host, options.signal);
    const paths = location.paths, current = state, execution = createManagedExecution(source.root, source.config, options.signal, []);
    const disposition = await readManagedDisposition(paths, state.runId);
    if (disposition && await hasPendingCheckoutIsolation(paths, disposition))
      throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'CHECKOUT_ISOLATION_PENDING' });
    archivePath = retirementArchivePath(paths, state.runId);
    const finalized = await readRetirementRecord(archivePath, paths);
    let hasOldLock = await pathExists(paths.lockPath);
    if (finalized) {
      await hasFinalizedRetirement(paths, current);
      if (finalized.host.hostId !== host.hostId) throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'RETIREMENT_HOST_CHANGED' });
      evidence = finalized;
    } else {
      if (!hasOldLock) throw new ReleaseError('LOCK_OWNERSHIP', { reason: 'RUN_LOCK_MISSING' });
      const checkpointPath = resolve(paths.slotRoot, 'retirement.json');
      const checkpoint = await readRetirementRecord(checkpointPath, paths);
      if (checkpoint?.runId === state.runId) evidence = checkpoint;
      else if (checkpoint) {
        const previous = await readRetirementRecord(retirementArchivePath(paths, checkpoint.runId), paths);
        if (!previous?.final || previous.snapshotSha256 !== checkpoint.snapshotSha256) {
          const disposition = await readManagedDisposition(paths, checkpoint.runId), snapshot = checkpoint.snapshot;
          if (!disposition || disposition.slotId !== checkpoint.slotId
            || !(['state', 'lock', 'anchor', 'owner', 'check', 'publish'] as const).every(key => disposition.snapshot[key] === snapshot[key])
            || disposition.snapshot.terminal !== (snapshot.terminal?.text ?? null))
            throw new ReleaseError('SLOT_STATE', { reason: 'RETIREMENT_PREVIOUS_INCOMPLETE' });
        }
      }
      if (!evidence) {
        const snapshot = await captureRetirementSnapshot(paths), snapshotSha256 = retirementDigest(snapshot);
        evidence = sealRetirementRecord({ schemaVersion: 1, kind: 'interrupted-run-retirement', runId: state.runId, slotId: state.slotId, snapshot, snapshotSha256,
          origin: 'recorded-run-host', host: state.host, preparedAt: startedAt });
      }
    }
    const selected = evidence;
    if (selected.runId !== state.runId || selected.slotId !== state.slotId) throw new ReleaseError('SLOT_STATE', { reason: 'RETIREMENT_BINDING' });
    if (JSON.stringify(JSON.parse(selected.snapshot.state)) !== JSON.stringify(current))
      throw new ReleaseError('SLOT_STATE', { reason: 'RETIREMENT_STATE_BINDING' });
    if (selected.host.hostId !== host.hostId || selected.host.platform !== host.platform) throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'RETIREMENT_HOST_CHANGED' });
    await assertRetirementSnapshot(paths, selected, hasOldLock);
    const cessation = retirementCessation(current, selected.snapshot);
    const lockValue = record(JSON.parse(selected.snapshot.lock)), lockIdentity = record(lockValue.identity);
    if (lockValue.runId !== state.runId || lockValue.pid !== state.coordinator.pid || lockValue.coordinatorLease !== state.coordinatorLease
      || lockIdentity.pid !== state.coordinator.pid || lockIdentity.startToken !== state.coordinator.startToken
      || typeof lockValue.token !== 'string' || !/^[a-f0-9-]{36}$/u.test(lockValue.token)) throw new ReleaseError('LOCK_OWNERSHIP', { reason: 'RUN_LOCK_BINDING' });
    const guard = async () => {
      assertActive(options.signal); await assertManagedPaths(paths); await assertManagementUntracked(source, execution);
      await assertRetirementSnapshot(paths, selected, hasOldLock);
      await assertManagedHistory(paths, current);
    };
    await guard();
    claim = await claimRetirement(paths, current, selected.snapshotSha256, lease, guard, options.signal);
    const ownedClaim = claim, writeGuard = async () => { await guard(); await ownedClaim.assertOwned(); };
    const restore = () => restoreManagedTerminal(paths, current, {
      allowReleasedLock: !hasOldLock, ...(options.signal ? { signal: options.signal } : {}) });
    const drained = cessation === 'recorded-empty-drained-scope' ? selected.snapshot : undefined;
    let observation = await inspectManagedRecovery((await restore()).state, paths, options.signal, undefined, lease, drained);
    processes = observation.processes;
    if (observation.owner === 'unknown') {
      try {
        const deadline = AbortSignal.timeout(Math.min(10_000, source.config.limits.commandMs));
        const found = await identityReader().readIdentity({ pid: current.coordinator.pid, signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline });
        // 这里只确认协调者实例；进程停止另由原运行的持久记录证明。
        if (found.status === 'ABSENT' || found.identity.startToken !== current.coordinator.startToken) observation = { ...observation, owner: 'inactive' };
      } catch { assertActive(options.signal); }
    }
    if (observation.owner !== 'inactive') throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'OWNER_NOT_INACTIVE', owner: observation.owner });
    if (hasUnresolvedRetirementEffects(current)) throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'RETIREMENT_EFFECT_UNPROVEN' });
    if (!cessation || (cessation !== 'recorded-empty-unstarted-scope' && observation.processes !== 'closed'))
      throw new ReleaseError('PROCESS_STATE_UNKNOWN', { reason: 'RETIREMENT_STOP_UNPROVEN' });
    const candidate = cessation === 'recorded-empty-drained-scope' ? drainedAcceptanceCandidate(current) : undefined;
    if (candidate) {
      await assertPathChain(paths.slotRoot, paths.checkoutRoot);
      if (!current.checkoutIdentity || !sameIdentity(await fileIdentity(paths.checkoutRoot), current.checkoutIdentity))
        throw new ReleaseError('ARTIFACT_CHANGED', { reason: 'PREBUILT_RESUME_CHECKOUT' });
      await assertRecordedPrebuiltArtifact(paths.checkoutRoot, source.config, candidate, options.signal);
    }
    if (!finalized) {
      const checkpointPath = resolve(paths.slotRoot, 'retirement.json');
      if (retirementDigest(await readRetirementRecord(checkpointPath, paths)) !== retirementDigest(selected)) await writeRetirementJson(checkpointPath, selected, paths, current, writeGuard);
      retirement = { status: 'prepared', historicalVerification: 'unknown', origin: selected.origin };
      const refs: ReleaseRecoveryObservation = cessation === 'recorded-stopped-scopes'
        ? await observeRefsForDisposition(execution, source, observation)
        : { ...observation, observedAt: new Date().toISOString(), developmentRef: { sha: '', relation: 'unknown' }, releaseRef: { sha: '', relation: 'unknown' } };
      await assertHistoricalSource(source, options.signal); await writeGuard();
      await assertPathChain(paths.slotRoot, dirname(archivePath)); await mkdir(dirname(archivePath), { recursive: true });
      evidence = sealRetirementRecord({ ...selected, final: { host, retiredAt: new Date().toISOString(), observation: refs, cessation } });
      await writeRetirementJson(archivePath, evidence, paths, current, writeGuard);
      await hasFinalizedRetirement(paths, current);
    }
    await writeGuard();
    await restore();
    if (hasOldLock) { await unlink(paths.lockPath); hasOldLock = false; }
    retirement = { status: 'retired', historicalVerification: 'unknown', origin: selected.origin,
      cessation, archivePath };
  } catch (error) { failure = diagnostic(error); }
  finally {
    try { await claim?.release(); } catch (error) { failure ??= diagnostic(error); }
    try { await lease?.release(); } catch (error) { failure ??= diagnostic(error); }
  }
  const source = state?.source;
  let nextCommand = state ? `retire --run-id ${state.runId}` : 'recover';
  if (failure?.details.reason === 'RETIREMENT_EFFECT_UNPROVEN') nextCommand = 'status';
  if (retirement?.status === 'retired' && state) {
    nextCommand = 'publish';
    if (state.prebuilt) nextCommand = drainedAcceptanceCandidate(state) ? 'status' : state.prebuilt.deploymentId ? 'verify' : 'status';
    else if (['pushed', 'already-current'].includes(state.effects.releasePush)) nextCommand = 'verify';
  }
  const reportPath = location ? retirement?.status === 'retired' && archivePath ? archivePath : resolve(location.paths.slotRoot, 'retirement.json') : undefined;
  let reportExists: boolean | undefined;
  if (reportPath) { try { reportExists = await pathExists(reportPath); } catch (error) { failure ??= diagnostic(error); } }
  return { schemaVersion: 2, command: options.command, ok: failure === undefined, startedAt, finishedAt: new Date().toISOString(), stage: failure ? 'retire' : 'complete', steps: [],
    effects: state?.effects ?? { developmentPush: 'not-attempted', releasePush: 'not-attempted' },
    ...(state ? { runId: state.runId, slotId: state.slotId, processes: { status: processes, knownCount: new Set(state.processes.flatMap(managedCommandIdentities).map(identity => `${identity.pid}:${identity.startToken}`)).size } } : {}),
    ...(source && location && state ? { candidateSha: source.sha, configSha256: source.configSha256, configPath: source.configPath, sourceRoot: source.root, executionRoot: location.paths.checkoutRoot,
      recovery: { candidateSha: source.sha, reportPath: reportPath ?? resolve(location.paths.slotRoot, 'retirement.json'), ...(reportExists === undefined ? {} : { reportExists }),
        nextCommand: recoveryCommand(nextCommand, source) } } : {}),
    ...(retirement ? { retirement } : {}), ...(failure ? { error: failure } : {}) };
}
