import { mkdir, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { ReleaseDiagnostic, ReleaseReport, RunReleaseOptions } from '../contracts.js';
import type { ManagedState } from './release-context.js';
import { hasSubsequentBoot, readRetirementHost, validRetirementHost, type RetirementHost } from './retirement-host.js';
import { assertHistoricalSource, frozenSource, inspectManagedRecovery, observeRefsForDisposition, readManagedLocation, type ManagedLocation } from './managed-recovery.js';
import { parseManagedState } from './managed-state.js';
import { assertActive, record, ReleaseError } from './errors.js';
import { assertManagedPaths, assertManagementUntracked } from './managed-paths.js';
import { assertPathChain, pathExists, readBoundedJson } from './managed-io.js';
import { acquireRetirementLease } from './retirement-lease.js';
import { assertRetirementSnapshot, captureRetirementSnapshot, hasFinalizedRetirement, readRetirementRecord, retirementArchivePath, retirementDigest, sealRetirementRecord, writeRetirementJson, type RetirementRecord } from './retirement-record.js';
import { claimRetirement } from './retirement-claim.js';
import { diagnostic } from './workspace-release.js';
import { createManagedExecution } from './managed-execution.js';
import { recoveryCommand } from './release-commands.js';
import { identityReader } from './process-identities.js';
import { managedCommandIdentities } from './managed-observation.js';

/** 宿主 reader 是内部 OS 观测边界；公开 API 不接受调用方注入关闭/开机证明。 */
export async function runManagedRetirement(options: RunReleaseOptions, hostReader: (signal?: AbortSignal) => Promise<RetirementHost> = readRetirementHost): Promise<ReleaseReport> {
  const startedAt = new Date().toISOString();
  let location: ManagedLocation | undefined, state: ManagedState | undefined, evidence: RetirementRecord | undefined;
  let lease: Awaited<ReturnType<typeof acquireRetirementLease>> | undefined, claim: Awaited<ReturnType<typeof claimRetirement>> | undefined;
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
    if (state.host && state.host.hostId !== host.hostId) throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'RETIREMENT_HOST_CHANGED' });
    lease = await acquireRetirementLease(location.paths, host, options.signal);
    const paths = location.paths, current = state, execution = createManagedExecution(source.root, source.config, options.signal, []);
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
        if (!previous?.final || previous.snapshotSha256 !== checkpoint.snapshotSha256) throw new ReleaseError('SLOT_STATE', { reason: 'RETIREMENT_PREVIOUS_INCOMPLETE' });
      }
      if (!evidence) {
        const snapshot = await captureRetirementSnapshot(paths), snapshotSha256 = retirementDigest(snapshot);
        const originConfirmation = retirementDigest({ runId: state.runId, slotId: state.slotId, snapshotSha256, hostId: host.hostId });
        if (!state.host) {
          retirement = { status: 'confirmation-required', historicalVerification: 'unknown', originConfirmation };
          if (options.confirmOrigin !== originConfirmation) throw new ReleaseError('RECOVERY_REQUIRED', { reason: options.confirmOrigin ? 'ORIGIN_CONFIRMATION_MISMATCH' : 'ORIGIN_CONFIRMATION_REQUIRED' });
        } else if (options.confirmOrigin !== undefined) throw new ReleaseError('ARGUMENT_INVALID', { reason: 'ORIGIN_ALREADY_RECORDED' });
        evidence = sealRetirementRecord({ schemaVersion: 1, kind: 'interrupted-run-retirement', runId: state.runId, slotId: state.slotId, snapshot, snapshotSha256,
          origin: state.host ? 'recorded-run-host' : 'operator-confirmed-origin', host: state.host ?? host, preparedAt: startedAt });
      }
    }
    const selected = evidence;
    if (selected.runId !== state.runId || selected.slotId !== state.slotId) throw new ReleaseError('SLOT_STATE', { reason: 'RETIREMENT_BINDING' });
    if (selected.host.hostId !== host.hostId || selected.host.platform !== host.platform) throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'RETIREMENT_HOST_CHANGED' });
    await assertRetirementSnapshot(paths, selected, hasOldLock);
    const lockValue = record(JSON.parse(selected.snapshot.lock)), lockIdentity = record(lockValue.identity);
    if (lockValue.runId !== state.runId || lockValue.pid !== state.coordinator.pid || lockIdentity.pid !== state.coordinator.pid || lockIdentity.startToken !== state.coordinator.startToken
      || typeof lockValue.token !== 'string' || !/^[a-f0-9-]{36}$/u.test(lockValue.token)) throw new ReleaseError('LOCK_OWNERSHIP', { reason: 'RUN_LOCK_BINDING' });
    const guard = async () => { assertActive(options.signal); await assertManagedPaths(paths); await assertManagementUntracked(source, execution); await assertRetirementSnapshot(paths, selected, hasOldLock); };
    await guard();
    claim = await claimRetirement(paths, current, selected.snapshotSha256, lease, guard, options.signal);
    const ownedClaim = claim, writeGuard = async () => { await guard(); await ownedClaim.assertOwned(); };
    let observation = await inspectManagedRecovery(current, paths, options.signal);
    if (selected.final || hasSubsequentBoot(selected.host, host)) {
      // 后续开机证明原实例已结束；当前复用 PID 的新进程不属于旧运行，历史 closure 仍保持 unknown。
      observation = { ...observation, owner: 'inactive' };
    } else if (observation.owner === 'unknown') {
      try {
        const deadline = AbortSignal.timeout(Math.min(10_000, source.config.limits.commandMs));
        const found = await identityReader().readIdentity({ pid: current.coordinator.pid, signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline });
        // 准备阶段只确认旧协调者已不在；这不能替代释放旧进程资源所需的开机证明。
        if (found.status === 'ABSENT' || found.identity.startToken !== current.coordinator.startToken) observation = { ...observation, owner: 'inactive' };
      } catch { assertActive(options.signal); }
    }
    if (observation.owner !== 'inactive') throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'OWNER_NOT_INACTIVE', owner: observation.owner });
    if (!finalized) {
      const checkpointPath = resolve(paths.slotRoot, 'retirement.json');
      if (retirementDigest(await readRetirementRecord(checkpointPath, paths)) !== retirementDigest(selected)) await writeRetirementJson(checkpointPath, selected, paths, current, writeGuard);
      retirement = { status: 'prepared', historicalVerification: 'unknown', origin: selected.origin };
      if (!hasSubsequentBoot(selected.host, host)) throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'SUBSEQUENT_BOOT_REQUIRED', baselineUptimeSeconds: selected.host.uptimeSeconds, observedUptimeSeconds: host.uptimeSeconds });
      const refs = await observeRefsForDisposition(execution, source, observation);
      await assertHistoricalSource(source, options.signal); await writeGuard();
      await assertPathChain(paths.slotRoot, dirname(archivePath)); await mkdir(dirname(archivePath), { recursive: true });
      evidence = sealRetirementRecord({ ...selected, final: { host, retiredAt: new Date().toISOString(), observation: refs } });
      await writeRetirementJson(archivePath, evidence, paths, current, writeGuard);
      await hasFinalizedRetirement(paths, current);
    }
    await writeGuard();
    if (hasOldLock) { await unlink(paths.lockPath); hasOldLock = false; }
    retirement = { status: 'retired', historicalVerification: 'unknown', origin: selected.origin, cessation: 'observed-subsequent-boot', archivePath };
  } catch (error) { failure = diagnostic(error); }
  finally {
    try { await claim?.release(); } catch (error) { failure = diagnostic(error); }
    try { await lease?.release(); } catch (error) { failure ??= diagnostic(error); }
  }
  const source = state?.source;
  const reportPath = location ? retirement?.status === 'retired' && archivePath ? archivePath : resolve(location.paths.slotRoot, 'retirement.json') : undefined;
  let reportExists: boolean | undefined;
  if (reportPath) { try { reportExists = await pathExists(reportPath); } catch (error) { failure ??= diagnostic(error); } }
  return { schemaVersion: 2, command: options.command, ok: failure === undefined, startedAt, finishedAt: new Date().toISOString(), stage: failure ? 'retire' : 'complete', steps: [],
    effects: state?.effects ?? { developmentPush: 'not-attempted', releasePush: 'not-attempted' },
    ...(state ? { runId: state.runId, slotId: state.slotId, processes: { status: 'unknown' as const, knownCount: new Set(state.processes.flatMap(managedCommandIdentities).map(identity => `${identity.pid}:${identity.startToken}`)).size } } : {}),
    ...(source && location && state ? { candidateSha: source.sha, configSha256: source.configSha256, configPath: source.configPath, sourceRoot: source.root, executionRoot: location.paths.checkoutRoot,
      recovery: { candidateSha: source.sha, reportPath: reportPath ?? resolve(location.paths.slotRoot, 'retirement.json'), ...(reportExists === undefined ? {} : { reportExists }),
        nextCommand: recoveryCommand(retirement?.status === 'retired' ? 'publish' : `retire --run-id ${state.runId}`, source) } } : {}),
    ...(retirement ? { retirement } : {}), ...(failure ? { error: failure } : {}) };
}
