import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { PrebuiltReleaseState, ReleaseCompletionAttempt, ReleaseCompletionState } from '../src/contracts.js';
import type { FrozenSource, ManagedCommand, ManagedState } from '../src/node/release-context.js';
import { createCompletionState } from '../src/node/completion-state.js';
import { assertCompletionRetryStopped, selectCompletionSnapshots } from '../src/node/completion-history.js';
import { configDigest } from '../src/node/source.js';
import { prebuiltConfiguration } from './helpers/prebuilt-configuration.js';
import { retirementDigest, sealRetirementRecord } from '../src/node/retirement-record.js';

// 协议反例只提供有格式的合成见证，不作为真实 OS 关闭或完整发布证据。
const now = '2026-11-03T00:00:00.000Z';
function command(runId: string, exitCode: number): ManagedCommand {
  const id = randomUUID(), scopeId = randomUUID(), binding = `${runId}:${id}:${randomUUID()}`;
  const identity = { pid: 123, startToken: 'protocol-instance' };
  return { id, name: 'completion:0', status: 'closed', descendants: [], observationComplete: true, identity,
    scope: { scopeId, binding }, terminalSha256: 'f'.repeat(64), closure: { observedAt: now, exitCode, termination: 'exit',
      ownedScope: { scopeId, binding, rootIdentity: identity, observedAt: now, status: 'closed', reason: 'normal', empty: true } } };
}
async function history() {
  const config = { ...prebuiltConfiguration(), completion: { idempotent: true as const, jobs: [{ command: 'node' }] } };
  const source: FrozenSource = { root: import.meta.dirname, sha: 'a'.repeat(40), configPath: 'release.config.json', config,
    configBlobOid: 'b'.repeat(40), configSha256: await configDigest(config), fetchUrl: config.git.repository };
  const prebuilt: PrebuiltReleaseState = { sourceSha: source.sha, configSha256: source.configSha256, artifactSha256: 'c'.repeat(64),
    fileCount: 2, byteLength: 100, createEffect: 'accepted', promoteEffect: 'accepted', deploymentId: 'dpl_candidate',
    deploymentUrl: 'https://candidate.vercel.app', acceptanceVerified: true, promotionVerified: true };
  const runId = randomUUID(), failedCommand = command(runId, 23);
  const failed: ReleaseCompletionAttempt = { runId, startedAt: now, finishedAt: now, durationMs: 10, status: 'failed',
    jobs: [{ index: 0, commandId: failedCommand.id, startedAt: now, finishedAt: now, durationMs: 10, status: 'failed',
      error: { code: 'COMPLETION_FAILED', details: { exitCode: 23 } } }], error: { code: 'COMPLETION_FAILED', details: {} } };
  const completion: ReleaseCompletionState = { ...createCompletionState(source, prebuilt, runId), status: 'failed', attempts: [failed] };
  const input = { schemaVersion: 1 as const, checkout: { dev: '1', ino: '1' }, git: { dev: '1', ino: '2' }, output: { dev: '1', ino: '3' },
    upload: { dev: '1', ino: '4' }, manifest: { identity: { dev: '1', ino: '5' }, sha256: 'f'.repeat(64) } };
  const original: ManagedState = { schemaVersion: 3, slotId: randomUUID(), runId, source, command: 'publish', history: [],
    host: { platform: 'linux', hostId: 'e'.repeat(64), uptimeSeconds: 1000, bootId: '11111111-1111-4111-8111-111111111111' },
    coordinator: { pid: 1, startToken: 'protocol' }, stage: 'completion', status: 'closed', processes: [failedCommand],
    effects: { developmentPush: 'not-attempted', releasePush: 'not-attempted', deploymentCreate: 'accepted', deploymentPromote: 'accepted' }, prebuilt, completion, completionInput: input };
  const retryRunId = randomUUID(), completedCommand = command(retryRunId, 0);
  const succeeded: ReleaseCompletionAttempt = { runId: retryRunId, startedAt: now, finishedAt: now, durationMs: 20, status: 'completed',
    jobs: [{ index: 0, commandId: completedCommand.id, startedAt: now, finishedAt: now, durationMs: 10, status: 'completed' }] };
  const retry: ManagedState = { ...original, runId: retryRunId, command: 'verify', stage: 'complete', processes: [completedCommand],
    completion: { ...completion, status: 'completed', attempts: [failed, succeeded] } };
  return { original, retry, completion, failed, succeeded, failedCommand, completedCommand };
}
it('selects a proved appended completion without rewriting the original failed publication', async () => {
  const value = await history(), saved = JSON.stringify(value.original);
  const snapshots = selectCompletionSnapshots([value.retry, value.original]);
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]?.completion).toEqual(value.retry.completion);
  expect(JSON.stringify(value.original)).toBe(saved);
  expect(snapshots[0] && assertCompletionRetryStopped(snapshots[0])).toBeUndefined();
});
it('keeps failure pending and refuses retry when an original process has no verified stop', async () => {
  const value = await history(), pending = { ...value.original,
    processes: [{ ...value.failedCommand, status: 'unknown' as const, observationComplete: false }] };
  const snapshots = selectCompletionSnapshots([pending]);
  expect(snapshots[0]?.completion.status).toBe('failed');
  expect(() => snapshots[0] && assertCompletionRetryStopped(snapshots[0])).toThrow('PROCESS_STATE_UNKNOWN');
});
it('rejects a completed boolean or job list backed by a failed, missing or different command', async () => {
  const value = await history();
  for (const processes of [value.original.processes, [], [{ ...value.completedCommand, name: 'check:0' }]]) {
    expect(() => selectCompletionSnapshots([value.original, { ...value.retry, processes }])).toThrow('SLOT_STATE');
  }
});
it('rejects an absent original publication, a mismatched target or a forked attempt history', async () => {
  const value = await history();
  expect(() => selectCompletionSnapshots([value.retry])).toThrow('SLOT_STATE');
  const context = { ...value.completion.context, deploymentId: 'dpl_other' };
  expect(() => selectCompletionSnapshots([value.original, { ...value.retry,
    completion: { ...value.retry.completion, schemaVersion: 1, publicationRunId: value.original.runId,
      status: 'completed', attempts: [value.failed, value.succeeded], context } }])).toThrow('SLOT_STATE');
  const fork = { ...value.retry, completion: { ...value.completion, status: 'failed' as const,
    attempts: [{ ...value.failed, runId: randomUUID() }] } };
  expect(() => selectCompletionSnapshots([value.original, fork])).toThrow('SLOT_STATE');
});

function retirement(state: ManagedState, publishRunId = state.completion?.publicationRunId) {
  const identity = { dev: '1', ino: '2' }, source = state.source, context = state.completion?.context;
  const snapshot = { state: JSON.stringify(state), lock: JSON.stringify({ runId: state.runId, pid: state.coordinator.pid, identity: state.coordinator }),
    anchor: JSON.stringify({ slotId: state.slotId, sourceRoot: source.root, configPath: source.configPath,
      latestPublish: { runId: publishRunId, sha: source.sha, configSha256: source.configSha256 } }),
    owner: JSON.stringify({ slotId: state.slotId, sourceRoot: source.root, configPath: source.configPath, repository: source.config.git.repository }),
    check: null, publish: null, identities: { state: identity, lock: identity, anchor: identity, owner: identity } };
  if (!context) throw new Error('completion fixture required');
  const host = state.host;
  return sealRetirementRecord({ schemaVersion: 1, kind: 'interrupted-run-retirement', runId: state.runId, slotId: state.slotId,
    snapshot, snapshotSha256: retirementDigest(snapshot), origin: 'recorded-run-host', host, preparedAt: now,
    final: { host: { ...host, uptimeSeconds: 20, bootId: '22222222-2222-4222-8222-222222222222' }, retiredAt: now,
      observation: { owner: 'inactive', processes: 'unknown', observedAt: now, developmentRef: { sha: source.sha, relation: 'unknown' }, releaseRef: { sha: source.sha, relation: 'unknown' } } } });
}

it('uses final retirement solely as cessation proof while retaining the original unknown command and attempt', async () => {
  const value = await history(), unknown: ManagedState = { ...value.original, status: 'unknown',
    processes: [{ ...value.failedCommand, status: 'unknown', observationComplete: false }] };
  const sealed = retirement(unknown), saved = JSON.stringify(unknown), record = JSON.stringify(sealed);
  // 后续开机只作为协议输入；这里没有模拟真实重启或生成真实OS关闭证明。
  const selected = selectCompletionSnapshots([unknown], [sealed]);
  expect(() => selected[0] && assertCompletionRetryStopped(selected[0])).not.toThrow();
  expect(JSON.stringify(unknown)).toBe(saved); expect(JSON.stringify(sealed)).toBe(record);
  expect(selected[0]?.completion.status).toBe('failed');
  expect(() => selectCompletionSnapshots([unknown, { ...value.retry, processes: [] }], [sealed])).toThrow('SLOT_STATE');
});

it('rejects incomplete, cross-run, cross-slot and mismatched-anchor retirement evidence', async () => {
  const value = await history(), sealed = retirement(value.original), prepared = { ...sealed }; delete prepared.final;
  const snapshot = { ...sealed.snapshot, anchor: JSON.stringify({ slotId: value.original.slotId, sourceRoot: value.original.source.root,
    configPath: value.original.source.configPath, latestPublish: { runId: randomUUID(), sha: value.original.source.sha, configSha256: value.original.source.configSha256 } }) };
  for (const proof of [sealRetirementRecord(prepared), sealRetirementRecord({ ...sealed, runId: randomUUID() }),
    sealRetirementRecord({ ...sealed, slotId: randomUUID() }), sealRetirementRecord({ ...sealed, snapshot, snapshotSha256: retirementDigest(snapshot) })])
    expect(() => selectCompletionSnapshots([value.original], [proof])).toThrow();
});

it.each(['publish', 'verify'] as const)('accepts retirement after a completed repeated publish in the same candidate lineage: %s', async kind => {
  const value = await history(), repeated: ManagedState = { ...value.retry, runId: randomUUID(), command: 'publish',
    status: 'unknown', processes: [{ id: randomUUID(), name: 'checkout-frozen', status: 'intent', descendants: [], observationComplete: false }] };
  const current: ManagedState = kind === 'publish' ? repeated : { ...repeated, runId: randomUUID(), command: 'verify' };
  const sealed = retirement(current, repeated.runId);
  const selected = selectCompletionSnapshots([value.original, value.retry, repeated, ...(kind === 'verify' ? [current] : [])], [sealed]);
  expect(selected[0]?.completion.status).toBe('completed');
  expect(selected[0]?.ceased).toContainEqual(current);
});
