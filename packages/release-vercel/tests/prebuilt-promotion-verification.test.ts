import { expect, it, vi } from 'vitest';
import type { PrebuiltReleaseState, ReleaseTransport } from '../src/contracts.js';
import { Execution } from '../src/node/execution.js';
import { observePrebuiltCandidate } from '../src/node/prebuilt-recovery.js';
import { createPrebuiltTransport } from '../src/node/prebuilt-vercel.js';
import { prebuiltConfiguration } from './helpers/prebuilt-configuration.js';

const state: PrebuiltReleaseState = {
  sourceSha: 'a'.repeat(40), configSha256: 'b'.repeat(64), artifactSha256: 'c'.repeat(64), fileCount: 2, byteLength: 100,
  deploymentId: 'dpl_candidate', deploymentUrl: 'https://candidate.vercel.app', createEffect: 'accepted', promoteEffect: 'unknown',
  acceptanceVerified: true, promotionVerified: false,
};
const hostname = 'fixture.example.invalid';
const binding = { alias: hostname, projectId: 'prj_fixture', deploymentId: 'dpl_candidate' };
const completedJob = { type: 'promote', jobStatus: 'succeeded', toDeploymentId: 'dpl_candidate' };

function fixture({ job = { lastAliasRequest: completedJob }, alias = {}, revision = state.sourceSha, productionMarker = {} }:
  { job?: { lastAliasRequest: unknown }; alias?: Record<string, unknown>; revision?: string; productionMarker?: Record<string, unknown> } = {}) {
  const config = prebuiltConfiguration();
  const paths: string[] = [];
  const inspected: string[] = [];
  const promote = vi.fn<NonNullable<ReleaseTransport['promote']>>();
  const transport: ReleaseTransport = {
    api: async path => {
      paths.push(path);
      const url = new URL(path, 'https://api.vercel.com');
      expect(url.searchParams.get('teamId')).toBe('team_fixture');
      switch (url.pathname) {
        case '/v9/projects/prj_fixture': return { id: 'prj_fixture', accountId: 'team_fixture', link: null,
          lastAliasRequest: url.searchParams.get('rollbackInfo') === 'true' ? job.lastAliasRequest : null };
        case '/v13/deployments/dpl_candidate': return { id: 'dpl_candidate', ownerId: 'team_fixture', projectId: 'prj_fixture',
          target: 'production', source: 'cli', readyState: 'READY', aliasAssigned: true, url: 'candidate.vercel.app' };
        case `/v4/aliases/${hostname}`: return { ...binding, ...alias };
        default: throw new Error('unexpected Vercel read');
      }
    },
    buildInfo: async url => {
      const parsed = new URL(url);
      inspected.push(`${parsed.hostname}${parsed.pathname}`);
      if (parsed.pathname === config.buildInfo.path) return { revision };
      const marker = { schemaVersion: 1, sourceSha: state.sourceSha, configSha256: state.configSha256, artifactSha256: state.artifactSha256 };
      return { ...marker, ...(parsed.hostname === hostname ? productionMarker : {}) };
    },
    promote,
  };
  const execution = new Execution(process.cwd(), config, undefined, []);
  return { paths, inspected, promote, verify: () => observePrebuiltCandidate(config, state,
    createPrebuiltTransport(execution, config, false, undefined, transport)) };
}

it('asks for the authoritative job and proves production without repeating promotion', async () => {
  const { verify, paths, inspected, promote } = fixture();
  await expect(verify()).resolves.toMatchObject({ deployment: { id: 'dpl_candidate' }, observed: { promoteEffect: 'accepted', promotionVerified: true } });
  expect(paths.filter(path => path.startsWith('/v9/'))).toEqual(Array(2).fill('/v9/projects/prj_fixture?rollbackInfo=true&teamId=team_fixture'));
  expect(inspected).toEqual(['candidate.vercel.app/.well-known/forge-prebuilt.json', `${hostname}/.well-known/forge-prebuilt.json`, `${hostname}/build-info.json`]);
  expect(state).toMatchObject({ promoteEffect: 'unknown', promotionVerified: false });
  expect(promote).not.toHaveBeenCalled();
});

it.each([
  ['missing', undefined, 'ALIAS_MISMATCH'],
  ['null', null, 'ALIAS_MISMATCH'],
  ['pending', { ...completedJob, jobStatus: 'pending' }, 'ALIAS_MISMATCH'],
  ['in-progress', { ...completedJob, jobStatus: 'in-progress' }, 'ALIAS_MISMATCH'],
  ['failed', { ...completedJob, jobStatus: 'failed' }, 'DEPLOYMENT_FAILED'],
  ['another deployment', { ...completedJob, toDeploymentId: 'dpl_other' }, 'ALIAS_MISMATCH'],
  ['rollback', { ...completedJob, type: 'rollback' }, 'ALIAS_MISMATCH'],
])('keeps the result unverified when the job is %s', async (_label, lastAliasRequest, code) => {
  const { verify, paths, promote } = fixture({ job: { lastAliasRequest } });
  await expect(verify()).rejects.toMatchObject({ code });
  expect(paths.some(path => path.startsWith('/v4/'))).toBe(false);
  expect(promote).not.toHaveBeenCalled();
});

it.each([
  [{ alias: { deploymentId: 'dpl_other' } }, 'ALIAS_MISMATCH'],
  [{ alias: { projectId: 'prj_other' } }, 'ALIAS_MISMATCH'],
  [{ productionMarker: { artifactSha256: 'd'.repeat(64) } }, 'ARTIFACT_CHANGED'],
  [{ revision: 'e'.repeat(40) }, 'BUILD_REVISION'],
])('requires the production alias, artifact marker and exact revision %j', async (input, code) => {
  const { verify, promote } = fixture(input);
  await expect(verify()).rejects.toMatchObject({ code });
  expect(promote).not.toHaveBeenCalled();
});
