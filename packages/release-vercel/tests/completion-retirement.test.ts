import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as gitBoundary from '../src/node/git.js';
import * as sourceBoundary from '../src/node/source.js';
import { createManagedSession } from '../src/node/managed-process.js';
import { selectManagedPublication } from '../src/node/managed-recovery.js';
import { createCompletionState } from '../src/node/completion-state.js';
import { captureRetirementSnapshot, retirementDigest, sealRetirementRecord } from '../src/node/retirement-record.js';
import { managedSessionFixture } from './helpers/managed-session-fixture.js';
import { readCompletionSnapshots } from '../src/node/completion-history.js';

vi.mock('../src/node/source.js', async original => ({ ...await original<typeof sourceBoundary>() }));
vi.mock('../src/node/git.js', async original => ({ ...await original<typeof gitBoundary>() }));
const fixtures: Awaited<ReturnType<typeof managedSessionFixture>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const value of fixtures.splice(0)) await value.dispose(); });

it('selects the anchor-bound retired original intent without manufacturing a missing successful publish receipt', async () => {
  const fixture = await managedSessionFixture({ extraConfig: {
    delivery: { mode: 'prebuilt', maxFiles: 100, maxBytes: 1_048_576,
      concurrencyControl: { mode: 'external-serialization', scope: 'fixture' }, admission: [{ command: 'node' }] },
    completion: { idempotent: true, jobs: [{ command: 'node' }] },
  } }); fixtures.push(fixture);
  const { slot, source } = fixture, session = await createManagedSession(slot, 'publish'), state = session.state;
  state.prebuilt = { sourceSha: source.sha, configSha256: source.configSha256, artifactSha256: 'a'.repeat(64),
    fileCount: 2, byteLength: 100, createEffect: 'accepted', promoteEffect: 'accepted', deploymentId: 'dpl_fixture',
    deploymentUrl: 'https://fixture.vercel.app', acceptanceVerified: true, promotionVerified: true };
  state.effects.deploymentCreate = 'accepted'; state.effects.deploymentPromote = 'accepted';
  const id = randomUUID(), now = new Date().toISOString(), input = { dev: '1', ino: '1' };
  state.completion = { ...createCompletionState(source, state.prebuilt, state.runId), status: 'running',
    attempts: [{ runId: state.runId, status: 'running', startedAt: now, jobs: [{ index: 0, status: 'running', startedAt: now, commandId: id }] }] };
  state.completionInput = { schemaVersion: 1, checkout: input, git: input, output: input, upload: input,
    manifest: { identity: input, sha256: 'b'.repeat(64) } };
  state.processes.push({ id, name: 'completion:0', status: 'intent', descendants: [], observationComplete: false });
  state.status = 'unknown'; state.stage = 'completion';
  // 此测试只提供停止协议输入，没有启动命令、伪造真实重启或声称真实生产成功。
  const host = { platform: 'linux' as const, hostId: 'c'.repeat(64), uptimeSeconds: 1000, bootId: randomUUID() };
  Object.assign(state, { host }); await session.persist();
  await slot.store.writeAnchor({ schemaVersion: 2, slotId: slot.slotId, sourceRoot: source.root, configPath: source.configPath,
    slotPath: slot.paths.slotRoot, latestPublish: { sha: source.sha, runId: state.runId, configSha256: source.configSha256 } });
  const snapshot = await captureRetirementSnapshot(slot.paths);
  const record = sealRetirementRecord({ schemaVersion: 1, kind: 'interrupted-run-retirement', runId: state.runId, slotId: state.slotId,
    snapshot, snapshotSha256: retirementDigest(snapshot), origin: 'recorded-run-host', host, preparedAt: now,
    final: { host: { ...host, bootId: randomUUID(), uptimeSeconds: 20 }, retiredAt: now,
      observation: { owner: 'inactive', processes: 'unknown', observedAt: now, developmentRef: { sha: source.sha, relation: 'unknown' }, releaseRef: { sha: source.sha, relation: 'unknown' } } } });
  await mkdir(resolve(slot.paths.slotRoot, 'retired'));
  const path = resolve(slot.paths.slotRoot, `retired/${state.runId}.json`), bytes = `${JSON.stringify(record)}\n`;
  await writeFile(path, bytes); await slot.lock.release();
  vi.spyOn(gitBoundary, 'assertRepository').mockResolvedValue(undefined);
  vi.spyOn(sourceBoundary, 'readCommittedConfig').mockResolvedValue({ config: source.config, bytes: Buffer.from(JSON.stringify(source.config)), oid: source.configBlobOid });
  const selected = await selectManagedPublication(fixture.cwd, source.configPath, source.sha);
  expect(selected.report).toMatchObject({ ok: false, runId: state.runId, completion: { status: 'running' },
    error: { code: 'RECOVERY_REQUIRED', details: { reason: 'ARCHIVED_PUBLICATION_INTENT' } } });
  expect(await readFile(path, 'utf8')).toBe(bytes);
  await expect(readFile(resolve(slot.paths.slotRoot, 'latest-publish.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  const prepared = { ...record }; delete prepared.final;
  await writeFile(path, JSON.stringify(sealRetirementRecord(prepared)));
  await expect(selectManagedPublication(fixture.cwd, source.configPath, source.sha)).rejects.toMatchObject({
    code: 'RECOVERY_REQUIRED', details: { reason: 'RETIREMENT_INCOMPLETE' } });
  // 以下正常关闭journal也是协议输入；只验证重复publish的封存关系，不作为OS成功证据。
  const identity = { pid: 4242, startToken: 'protocol' }, scope = { scopeId: randomUUID(), binding: `${state.runId}:${id}:${randomUUID()}` };
  const completed = { ...state, status: 'closed' as const, processes: [{ id, name: 'completion:0', status: 'closed' as const,
    descendants: [], observationComplete: true, identity, scope, terminalSha256: 'f'.repeat(64),
    closure: { observedAt: now, exitCode: 0, termination: 'exit' as const,
      ownedScope: { ...scope, rootIdentity: identity, observedAt: now, status: 'closed' as const, reason: 'normal' as const, empty: true } } }],
  completion: { ...state.completion, status: 'completed' as const, attempts: [{ runId: state.runId, startedAt: now, finishedAt: now,
    durationMs: 0, status: 'completed' as const, jobs: [{ index: 0, commandId: id, startedAt: now, finishedAt: now, durationMs: 0, status: 'completed' as const }] }] } };
  const completedSnapshot = { ...snapshot, state: JSON.stringify(completed) };
  const completedRecord = sealRetirementRecord({ ...record, snapshot: completedSnapshot, snapshotSha256: retirementDigest(completedSnapshot) });
  const repeatedRunId = randomUUID(), repeated = { ...completed, runId: repeatedRunId, status: 'unknown' as const,
    processes: [{ id: randomUUID(), name: 'checkout-frozen', status: 'intent' as const, descendants: [], observationComplete: false }] };
  const anchor = { ...JSON.parse(snapshot.anchor), latestPublish: { runId: repeatedRunId, sha: source.sha, configSha256: source.configSha256 } };
  const repeatedSnapshot = { ...snapshot, state: JSON.stringify(repeated), anchor: JSON.stringify(anchor),
    lock: JSON.stringify({ ...JSON.parse(snapshot.lock), runId: repeatedRunId }) };
  const repeatedRecord = sealRetirementRecord({ ...record, runId: repeatedRunId, snapshot: repeatedSnapshot, snapshotSha256: retirementDigest(repeatedSnapshot) });
  const repeatedPath = resolve(slot.paths.slotRoot, `retired/${repeatedRunId}.json`);
  const firstBytes = JSON.stringify(completedRecord), repeatedBytes = JSON.stringify(repeatedRecord);
  await writeFile(path, firstBytes); await writeFile(repeatedPath, repeatedBytes); await writeFile(slot.paths.anchorPath, JSON.stringify(anchor));
  const later = await selectManagedPublication(fixture.cwd, source.configPath, source.sha);
  expect(later.report).toMatchObject({ ok: false, runId: repeatedRunId,
    completion: { publicationRunId: state.runId, status: 'completed' }, error: { details: { reason: 'ARCHIVED_PUBLICATION_INTENT' } } });
  expect(await readFile(path, 'utf8')).toBe(firstBytes); expect(await readFile(repeatedPath, 'utf8')).toBe(repeatedBytes);
  await expect(readFile(resolve(slot.paths.slotRoot, 'latest-publish.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['check', 'publish'] as const)('does not pin a final-retired %s that never created a completion intent', async command => {
  const fixture = await managedSessionFixture({ extraConfig: {
    delivery: { mode: 'prebuilt', maxFiles: 100, maxBytes: 1_048_576,
      concurrencyControl: { mode: 'external-serialization', scope: 'fixture' }, admission: [{ command: 'node' }] },
    completion: { idempotent: true, jobs: [{ command: 'node' }] },
  } }); fixtures.push(fixture);
  const { slot, source } = fixture, session = await createManagedSession(slot, command), state = session.state;
  state.status = 'unknown';
  state.processes.push({ id: randomUUID(), name: 'install', status: 'intent', descendants: [], observationComplete: false });
  // 合成后续开机只验证协议选择；本例没有启动业务进程或声称OS正常关闭。
  const host = { platform: 'linux' as const, hostId: 'c'.repeat(64), uptimeSeconds: 1000, bootId: randomUUID() };
  Object.assign(state, { host }); await session.persist();
  const snapshot = await captureRetirementSnapshot(slot.paths), now = new Date().toISOString();
  const record = sealRetirementRecord({ schemaVersion: 1, kind: 'interrupted-run-retirement', runId: state.runId, slotId: state.slotId,
    snapshot, snapshotSha256: retirementDigest(snapshot), origin: 'recorded-run-host', host, preparedAt: now,
    final: { host: { ...host, bootId: randomUUID(), uptimeSeconds: 20 }, retiredAt: now,
      observation: { owner: 'inactive', processes: 'unknown', observedAt: now, developmentRef: { sha: source.sha, relation: 'unknown' }, releaseRef: { sha: source.sha, relation: 'unknown' } } } });
  await mkdir(resolve(slot.paths.slotRoot, 'retired'));
  const path = resolve(slot.paths.slotRoot, `retired/${state.runId}.json`), bytes = JSON.stringify(record);
  await writeFile(path, bytes); await slot.lock.release();
  expect(await readCompletionSnapshots(slot.paths, slot.slotId)).toEqual([]);
  expect(await readFile(path, 'utf8')).toBe(bytes);
});
