import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseManagedState } from '../src/node/managed-state.js';
import type { ManagedState, PrebuiltEffectResolution } from '../src/node/release-context.js';
import { assertPrebuiltEffectObserved, matchesPrebuiltResolution } from '../src/node/prebuilt-recovery.js';
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
