import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseManagedReceipt, parseManagedState } from '../src/node/managed-state.js';
import type { ManagedState, PrebuiltEffectResolution } from '../src/node/release-context.js';
import { assertPrebuiltEffectObserved, hasUnresolvedPrebuiltEffect, matchesPrebuiltResolution } from '../src/node/prebuilt-recovery.js';
import { Execution } from '../src/node/execution.js';
import { prebuiltConfiguration } from './helpers/prebuilt-configuration.js';

const sourceSha = 'a'.repeat(40), configSha256 = 'b'.repeat(64);
function state(): ManagedState {
  // 这里只验证持久协议结构，不把组件输入声称为真实 Git 提交或 OS 关闭证据。
  return { schemaVersion: 3, slotId: '11111111-1111-1111-1111-111111111111', runId: '22222222-2222-2222-2222-222222222222',
    source: { root: resolve(import.meta.dirname, 'protocol-input'), sha: sourceSha, configPath: 'release.config.json',
      config: prebuiltConfiguration(), configSha256, configBlobOid: 'c'.repeat(40), fetchUrl: 'https://github.com/fixture/repository.git' },
    command: 'publish', coordinator: { pid: 1, startToken: 'fixture' }, history: [], stage: 'deployment', status: 'closed', processes: [],
    effects: { developmentPush: 'not-attempted', releasePush: 'not-attempted', deploymentCreate: 'accepted', deploymentPromote: 'not-attempted' },
    prebuilt: { sourceSha, configSha256, artifactSha256: 'd'.repeat(64), fileCount: 2, byteLength: 100,
      createEffect: 'accepted', promoteEffect: 'not-attempted', deploymentId: 'dpl_candidate', deploymentUrl: 'https://candidate.vercel.app',
      acceptanceVerified: false, promotionVerified: false } };
}
describe('durable prebuilt candidate binding', () => {
  it('accepts a candidate bound to the frozen source, config and independent cloud effects', () => {
    const input = state(); expect(parseManagedState(input, input.source, input.slotId).prebuilt).toEqual(input.prebuilt);
  });
  it.each([
    { sourceSha: 'e'.repeat(40) }, { configSha256: 'e'.repeat(64) }, { artifactSha256: 'invalid' },
    { fileCount: 0 }, { byteLength: -1 }, { createEffect: 'not-attempted' }, { deploymentId: undefined },
    { deploymentUrl: 'https://attacker.invalid' }, { promoteEffect: 'accepted' }, { promotionVerified: true },
  ])('refuses corrupted or impossible candidate transitions %#', patch => {
    const input = state(); if (!input.prebuilt) throw new Error('candidate required'); Object.assign(input.prebuilt, patch);
    expect(() => parseManagedState(input, input.source, input.slotId)).toThrow('SLOT_STATE');
  });
  it('refuses disagreement between the effect journal and the selected candidate', () => {
    const input = state(); input.effects.deploymentCreate = 'not-attempted';
    expect(() => parseManagedState(input, input.source, input.slotId)).toThrow('SLOT_STATE');
  });
  it('requires every original source, artifact, config, deployment and promotion binding in a historical resolution', () => {
    const input = state(); if (!input.prebuilt) throw new Error('candidate required');
    input.prebuilt.acceptanceVerified = true; input.prebuilt.promoteEffect = 'unknown'; input.effects.deploymentPromote = 'unknown';
    const proof: PrebuiltEffectResolution = { schemaVersion: 1, runId: input.runId, sourceSha, configSha256,
      artifactSha256: input.prebuilt.artifactSha256, deploymentId: 'dpl_candidate', promotion: 'succeeded', observedAt: '2026-11-02T00:00:00.000Z' };
    input.prebuiltResolutions = [proof];
    expect(parseManagedState(input, input.source, input.slotId).prebuiltResolutions).toEqual([proof]);
    expect(matchesPrebuiltResolution(input, proof)).toBe(true);
    for (const patch of [{ runId: '33333333-3333-3333-3333-333333333333' }, { sourceSha: 'e'.repeat(40) },
      { configSha256: 'e'.repeat(64) }, { artifactSha256: 'e'.repeat(64) }, { deploymentId: 'dpl_other' }, { promotion: 'not-attempted' as const }]) {
      expect(matchesPrebuiltResolution(input, { ...proof, ...patch })).toBe(false);
    }
    for (const patch of [{ sourceSha: 'invalid' }, { artifactSha256: 'invalid' }, { deploymentId: 'other' }, { observedAt: 'invalid' }]) {
      input.prebuiltResolutions = [{ ...proof, ...patch }];
      expect(() => parseManagedState(input, input.source, input.slotId)).toThrow('SLOT_STATE');
    }
    input.prebuiltResolutions = [proof, proof];
    expect(() => parseManagedState(input, input.source, input.slotId)).toThrow('SLOT_STATE');
  });
  it('settles an authoritative failed promotion without claiming success or rewriting the original unknown', async () => {
    const input = state(); if (!input.prebuilt) throw new Error('candidate required');
    input.prebuilt.acceptanceVerified = true; input.prebuilt.promoteEffect = 'unknown'; input.effects.deploymentPromote = 'unknown';
    const proof = await assertPrebuiltEffectObserved(input, new Execution(input.source.root, input.source.config, undefined, []), {
      api: async path => path.startsWith('/v9/projects/')
        ? { id: 'prj_fixture', accountId: 'team_fixture', link: null, lastAliasRequest: { type: 'promote', toDeploymentId: 'dpl_candidate', jobStatus: 'failed' } }
        : { id: 'dpl_candidate', ownerId: 'team_fixture', projectId: 'prj_fixture', target: 'production', source: 'cli', readyState: 'READY', url: 'candidate.vercel.app' },
      buildInfo: async () => { throw new Error('a terminal failure must not require a successful production alias'); },
    });
    expect(proof).toMatchObject({ runId: input.runId, sourceSha, configSha256, deploymentId: 'dpl_candidate', promotion: 'failed' });
    if (!proof) throw new Error('resolution required');
    expect(matchesPrebuiltResolution(input, proof)).toBe(true);
    expect(input.prebuilt.promoteEffect).toBe('unknown'); expect(input.prebuilt.promotionVerified).toBe(false);
  });
});

function aliasState(): ManagedState {
  const input = state();
  if (!input.source.config.delivery || !input.prebuilt) throw new Error('prebuilt required');
  Object.assign(input.source.config.delivery, { versionAlias: { hostnameTemplate: 'fixture-{sha}.vercel.app' } });
  input.prebuilt.versionAlias = { hostname: `fixture-${sourceSha}.vercel.app`, effect: 'unknown', verified: false };
  input.effects.versionAliasAssign = 'unknown';
  return input;
}

describe('durable version alias identity and independent effect', () => {
  it('keeps alias uncertainty independently unresolved after all local processes have stopped', () => {
    const input = aliasState();
    expect(hasUnresolvedPrebuiltEffect(input)).toBe(true);
    expect(parseManagedState(input, input.source, input.slotId).prebuilt).toEqual(input.prebuilt);
    if (!input.prebuilt?.versionAlias) throw new Error('alias required');
    input.prebuilt.versionAlias.effect = 'accepted'; input.effects.versionAliasAssign = 'accepted';
    expect(hasUnresolvedPrebuiltEffect(input)).toBe(true);
  });
  it.each([
    { hostname: `fixture-${'e'.repeat(40)}.vercel.app` }, { hostname: 'fixture.example.invalid' },
    { hostname: undefined }, { effect: 'invalid' }, { verified: true }, { verified: 'true' }, { credential: 'fixture-only' },
  ])('rejects a damaged or impossible alias record %j', patch => {
    const input = aliasState(); Object.assign(input.prebuilt?.versionAlias ?? {}, patch);
    expect(() => parseManagedState(input, input.source, input.slotId)).toThrow('SLOT_STATE');
  });
  it('requires an alias record and matching independent effect only when the option was frozen', () => {
    const missing = aliasState(); if (!missing.prebuilt) throw new Error('prebuilt required');
    delete missing.prebuilt.versionAlias;
    expect(() => parseManagedState(missing, missing.source, missing.slotId)).toThrow('SLOT_STATE');
    const disagreement = aliasState(); disagreement.effects.versionAliasAssign = 'accepted';
    expect(() => parseManagedState(disagreement, disagreement.source, disagreement.slotId)).toThrow('SLOT_STATE');
    const legacy = state(); Object.assign(legacy.prebuilt ?? {}, { versionAlias: { hostname: `fixture-${sourceSha}.vercel.app`, effect: 'unknown', verified: false } });
    legacy.effects.versionAliasAssign = 'unknown';
    expect(() => parseManagedState(legacy, legacy.source, legacy.slotId)).toThrow('SLOT_STATE');
  });
  it('refuses acceptance or promotion before the version route was verified', () => {
    const input = aliasState(); if (!input.prebuilt) throw new Error('prebuilt required');
    input.prebuilt.acceptanceVerified = true;
    expect(() => parseManagedState(input, input.source, input.slotId)).toThrow('SLOT_STATE');
  });
  it('requires the historical proof to name the original hostname and source binding', () => {
    const input = aliasState(), proof = { schemaVersion: 1 as const, runId: input.runId, sourceSha, configSha256,
      artifactSha256: 'd'.repeat(64), deploymentId: 'dpl_candidate', promotion: 'not-attempted' as const,
      versionAlias: { hostname: `fixture-${sourceSha}.vercel.app`, verified: true as const }, observedAt: '2026-11-02T00:00:00.000Z' };
    expect(matchesPrebuiltResolution(input, proof)).toBe(true);
    const { versionAlias: omitted, ...withoutAlias } = proof;
    expect(omitted).toBeDefined(); expect(matchesPrebuiltResolution(input, withoutAlias)).toBe(false);
    expect(matchesPrebuiltResolution(input, { ...proof, versionAlias: { hostname: `other-${sourceSha}.vercel.app`, verified: true } })).toBe(false);
    input.prebuiltResolutions = [{ ...proof, versionAlias: { hostname: `fixture-${'e'.repeat(40)}.vercel.app`, verified: true } }];
    expect(() => parseManagedState(input, input.source, input.slotId)).toThrow('SLOT_STATE');
  });
  it('observes an exact alias and marker without changing the original unknown journal', async () => {
    const input = aliasState(); let writes = 0;
    const proof = await assertPrebuiltEffectObserved(input, new Execution(input.source.root, input.source.config, undefined, []), {
      api: async path => path.startsWith('/v9/projects/')
        ? { id: 'prj_fixture', accountId: 'team_fixture', link: null }
        : { id: 'dpl_candidate', ownerId: 'team_fixture', projectId: 'prj_fixture', target: 'production', source: 'cli', readyState: 'READY', url: 'candidate.vercel.app' },
      buildInfo: async url => new URL(url).pathname === '/.well-known/forge-prebuilt.json'
        ? { schemaVersion: 1, sourceSha, configSha256, artifactSha256: 'd'.repeat(64) } : { revision: sourceSha },
      versionAlias: { read: async hostname => ({ alias: hostname, projectId: 'prj_fixture', deploymentId: 'dpl_candidate', routing: 'direct' }),
        assign: async () => { writes++; throw new Error('observation must not assign'); } },
    });
    expect(proof).toMatchObject({ versionAlias: { hostname: `fixture-${sourceSha}.vercel.app`, verified: true } });
    expect(writes).toBe(0); expect(input.prebuilt?.versionAlias?.effect).toBe('unknown');
  });
  it.each([{ artifactSha256: 'e'.repeat(64) }, { deploymentId: 'dpl_other' },
    { versionUrl: 'https://other.vercel.app' }, { token: 'fixture-only' }])('rejects a forged or secret-bearing public candidate context %j', patch => {
    const input = aliasState();
    const candidateContext = { teamId: 'team_fixture', projectId: 'prj_fixture', sourceSha, configSha256, artifactSha256: 'd'.repeat(64),
      deploymentId: 'dpl_candidate', candidateUrl: 'https://candidate.vercel.app', versionUrl: `https://fixture-${sourceSha}.vercel.app`, versionAliasVerified: false, ...patch };
    const receipt = { schemaVersion: 2, slotId: input.slotId, source: input.source, report: { schemaVersion: 2, command: 'publish', ok: false,
      startedAt: '2026-11-02T00:00:00.000Z', finishedAt: '2026-11-02T00:00:01.000Z', candidateSha: sourceSha, configSha256,
      steps: [], effects: input.effects, prebuilt: input.prebuilt, candidateContext } };
    expect(() => parseManagedReceipt(receipt, input.source, input.slotId)).toThrow('SLOT_STATE');
  });
});
