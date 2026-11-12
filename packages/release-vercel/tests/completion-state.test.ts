import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { PrebuiltReleaseState } from '../src/contracts.js';
import type { FrozenSource, ManagedState } from '../src/node/release-context.js';
import { parseManagedReceipt, parseManagedState } from '../src/node/managed-state.js';
import { createCompletionState, observedCompletionState, parseCompletionState, protectedCompletionEnvironment } from '../src/node/completion-state.js';
import { configDigest } from '../src/node/source.js';
import { prebuiltConfiguration } from './helpers/prebuilt-configuration.js';

// 只测试结构化协议输入；这些 UUID/关闭占位不是来自真实 Git 或 OS 的完成证明。
async function protocol() {
  const config = { ...prebuiltConfiguration(), completion: { idempotent: true as const,
    jobs: [{ command: 'node', args: ['completion.mjs'] }] } };
  const source: FrozenSource = { root: import.meta.dirname, sha: 'a'.repeat(40), configPath: 'release.config.json', config,
    configBlobOid: 'b'.repeat(40), configSha256: await configDigest(config), fetchUrl: config.git.repository };
  const prebuilt: PrebuiltReleaseState = { sourceSha: source.sha, configSha256: source.configSha256, artifactSha256: 'c'.repeat(64),
    fileCount: 2, byteLength: 64, createEffect: 'accepted', promoteEffect: 'unknown', deploymentId: 'dpl_candidate',
    deploymentUrl: 'https://candidate.vercel.app', acceptanceVerified: true, promotionVerified: false };
  const input = { schemaVersion: 1 as const, checkout: { dev: '1', ino: '1' }, git: { dev: '1', ino: '2' }, output: { dev: '1', ino: '3' },
    upload: { dev: '1', ino: '4' }, manifest: { identity: { dev: '1', ino: '5' }, sha256: 'f'.repeat(64) } };
  return { source, prebuilt, runId: randomUUID(), input };
}
it('records an exact not-started completion intent without claiming production or job success', async () => {
  const value = await protocol(), state = createCompletionState(value.source, value.prebuilt, value.runId);
  expect(state).toMatchObject({ schemaVersion: 1, publicationRunId: value.runId, status: 'not-started', attempts: [], context: {
    productionUrl: 'https://fixture.example.invalid', candidateUrl: value.prebuilt.deploymentUrl,
    sourceSha: value.source.sha, configSha256: value.source.configSha256, artifactSha256: value.prebuilt.artifactSha256,
    deploymentId: 'dpl_candidate', teamId: 'team_fixture', projectId: 'prj_fixture',
  } });
  expect(parseCompletionState(state, value.source, value.prebuilt)).toEqual(state);
});
it('does not manufacture completion for existing configurations or a non-promoted candidate', async () => {
  const value = await protocol();
  expect(parseCompletionState(undefined, value.source, { ...value.prebuilt, promoteEffect: 'not-attempted' })).toBeUndefined();
  expect(() => parseCompletionState(undefined, value.source, value.prebuilt)).toThrow('SLOT_STATE');
  const source = { ...value.source, config: prebuiltConfiguration() };
  expect(parseCompletionState(undefined, source, value.prebuilt)).toBeUndefined();
  expect(() => parseCompletionState(createCompletionState(value.source, value.prebuilt, value.runId), source, value.prebuilt)).toThrow('SLOT_STATE');
});
it.each(['state', 'receipt'])('validates completion inside durable %s before accepting a claimed result', async kind => {
  const value = await protocol(), completion = createCompletionState(value.source, value.prebuilt, value.runId), slotId = randomUUID();
  const state: ManagedState = { schemaVersion: 3, slotId, runId: value.runId, source: value.source,
    command: 'publish', coordinator: { pid: 1, startToken: 'protocol' },
    host: { platform: 'win32', hostId: 'e'.repeat(64), uptimeSeconds: 1000 }, history: [], stage: 'completion', status: 'closed', processes: [],
    effects: { developmentPush: 'not-attempted', releasePush: 'not-attempted', deploymentCreate: 'accepted', deploymentPromote: 'unknown' },
    prebuilt: value.prebuilt, completion, completionInput: value.input };
  const corrupted = { ...completion, context: { ...completion.context, productionUrl: 'https://forged.invalid' } };
  if (kind === 'state') {
    expect(parseManagedState(state, value.source, slotId)).toEqual(state);
    expect(() => parseManagedState({ ...state, completion: corrupted }, value.source, slotId)).toThrow('SLOT_STATE');
  } else {
    const report = { schemaVersion: 2, command: 'publish', ok: false, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      steps: [], effects: state.effects, candidateSha: value.source.sha, configSha256: value.source.configSha256, prebuilt: value.prebuilt, completion };
    expect(parseManagedReceipt({ schemaVersion: 2, slotId, source: value.source, report }, value.source, slotId).report.completion).toEqual(completion);
    expect(() => parseManagedReceipt({ schemaVersion: 2, slotId, source: value.source, report: { ...report, completion: corrupted } }, value.source, slotId)).toThrow('SLOT_STATE');
  }
});
it('requires a private original-input binding for durable completion while keeping it out of public receipts', async () => {
  const value = await protocol(), completion = createCompletionState(value.source, value.prebuilt, value.runId), slotId = randomUUID();
  const input = { schemaVersion: 1, checkout: { dev: '1', ino: '1' }, git: { dev: '1', ino: '2' }, output: { dev: '1', ino: '3' },
    upload: { dev: '1', ino: '4' }, manifest: { identity: { dev: '1', ino: '5' }, sha256: 'f'.repeat(64) } };
  const state = { schemaVersion: 3, slotId, runId: value.runId, source: value.source,
    command: 'publish', coordinator: { pid: 1, startToken: 'protocol' },
    host: { platform: 'win32', hostId: 'e'.repeat(64), uptimeSeconds: 1000 }, history: [], stage: 'completion', status: 'closed', processes: [],
    effects: { developmentPush: 'not-attempted', releasePush: 'not-attempted', deploymentCreate: 'accepted', deploymentPromote: 'unknown' },
    prebuilt: value.prebuilt, completion, completionInput: input };
  expect(parseManagedState(state, value.source, slotId)).toEqual(state);
  expect(() => parseManagedState({ ...state, completionInput: undefined }, value.source, slotId)).toThrow('SLOT_STATE');
  expect(() => parseManagedState({ ...state, completionInput: { ...input, manifest: { ...input.manifest, sha256: 'bad' } } }, value.source, slotId)).toThrow('SLOT_STATE');
});
it.each(['sourceSha', 'configSha256', 'artifactSha256', 'deploymentId', 'productionUrl', 'candidateUrl', 'teamId', 'projectId'] as const)(
  'rejects a changed completion context %s', async key => {
    const value = await protocol(), state = createCompletionState(value.source, value.prebuilt, value.runId);
    expect(() => parseCompletionState({ ...state, context: { ...state.context, [key]: 'forged' } }, value.source, value.prebuilt)).toThrow('SLOT_STATE');
  });
it('rejects unbounded attempts, invalid origins and ambiguous progress without accepting booleans as proof', async () => {
  const value = await protocol(), state = createCompletionState(value.source, value.prebuilt, value.runId);
  const startedAt = new Date().toISOString(), attempt = { runId: value.runId, status: 'running', startedAt, jobs: [] };
  for (const changed of [
    { ...state, publicationRunId: 'invalid' }, { ...state, completed: true }, { ...state, status: 'completed' },
    { ...state, status: 'running', attempts: Array.from({ length: 33 }, () => attempt) },
    { ...state, status: 'running', attempts: [attempt, attempt] },
    { ...state, status: 'running', attempts: [{ ...attempt, jobs: [{ index: 1, status: 'running', startedAt }] }] },
    { ...state, status: 'completed', attempts: [{ ...attempt, status: 'completed', finishedAt: startedAt, durationMs: 1,
      jobs: [{ index: 0, status: 'completed', startedAt, finishedAt: startedAt, durationMs: 1 }] }] },
  ]) expect(() => parseCompletionState(changed, value.source, value.prebuilt)).toThrow('SLOT_STATE');
});
it('preserves a prior unknown attempt when an explicitly retried attempt completes', async () => {
  const value = await protocol(), state = createCompletionState(value.source, value.prebuilt, value.runId);
  const startedAt = new Date().toISOString();
  const failed = { runId: value.runId, status: 'unknown', startedAt, finishedAt: startedAt, durationMs: 10,
    jobs: [], error: { code: 'PROCESS_STATE_UNKNOWN', details: { reason: 'CLOSURE_UNPROVEN' } } };
  const succeeded = { runId: randomUUID(), status: 'completed', startedAt, finishedAt: startedAt, durationMs: 20,
    jobs: [{ index: 0, commandId: randomUUID(), status: 'completed', startedAt, finishedAt: startedAt, durationMs: 10 }] };
  const retried = { ...state, status: 'completed', attempts: [failed, succeeded] };
  expect(parseCompletionState(retried, value.source, value.prebuilt)).toEqual(retried);
  expect(retried.attempts[0]).toEqual(failed);
});
it('only exposes protected stable production metadata after production proof for completion jobs', async () => {
  const value = await protocol(), state = createCompletionState(value.source, value.prebuilt, value.runId);
  expect(protectedCompletionEnvironment(value.source, value.prebuilt, state, 'check:0'))
    .toEqual({ FORGE_RELEASE_COMPLETION_CONTEXT: '' });
  expect(() => protectedCompletionEnvironment(value.source, value.prebuilt, state, 'completion:0')).toThrow('RECOVERY_REQUIRED');
  const proven = { ...value.prebuilt, promoteEffect: 'accepted' as const, promotionVerified: true };
  const environment = protectedCompletionEnvironment(value.source, proven, state, 'completion:0');
  expect(environment).toMatchObject({ FORGE_RELEASE_URL: 'https://fixture.example.invalid', FORGE_RELEASE_PHASE: 'completion',
    FORGE_RELEASE_DEPLOYMENT_ID: 'dpl_candidate', FORGE_RELEASE_ARTIFACT_SHA256: value.prebuilt.artifactSha256,
    FORGE_RELEASE_CONFIG_SHA256: value.source.configSha256, FORGE_RELEASE_VERSION_URL: '' });
  expect(JSON.parse(environment.FORGE_RELEASE_COMPLETION_CONTEXT ?? '')).toEqual(state.context);
});
it('reports a stopped or unknown former running attempt as unknown without rewriting its original intent', async () => {
  const value = await protocol(), state = createCompletionState(value.source, value.prebuilt, value.runId);
  const running = { ...state, status: 'running' as const,
    attempts: [{ runId: value.runId, status: 'running' as const, startedAt: new Date().toISOString(), jobs: [] }] };
  const original = JSON.stringify(running);
  expect(observedCompletionState(running, value.runId, 'active')).toEqual(running);
  expect(observedCompletionState(running, value.runId, 'inactive')).toMatchObject({ status: 'unknown', attempts: running.attempts });
  expect(observedCompletionState(running, randomUUID(), 'active')?.status).toBe('unknown');
  expect(observedCompletionState(running, value.runId, 'unknown')?.status).toBe('unknown');
  expect(observedCompletionState(state, value.runId, 'inactive')).toEqual(state);
  expect(observedCompletionState(undefined, undefined, 'unknown')).toBeUndefined();
  expect(JSON.stringify(running)).toBe(original);
});
