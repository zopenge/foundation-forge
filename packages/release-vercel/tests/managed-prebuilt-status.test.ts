import { fixture } from './helpers/prebuilt-publication-fixture.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { ReleaseTransport } from '../src/contracts.js';
import { runRelease, ReleaseError } from '../src/node.js';

const blocked = { readyState: 'BLOCKED', readySubstate: 'STAGED', aliasAssigned: false, alwaysRefuseToBuild: true };
type Fixture = Awaited<ReturnType<typeof fixture>>;

function observe(value: Fixture, response: Readonly<Record<string, unknown>>) {
  value.hooks.deployment = response;
  const candidatePath = '/v13/deployments/dpl_candidate?teamId=team_fixture';
  const requests: string[] = [];
  const expectNoCall = vi.fn(() => { throw new Error('failed status must not perform further verification or writes'); });
  const transport: ReleaseTransport = {
    api: async (path, signal) => {
      requests.push(path);
      if (requests.length > 2) throw new Error('failed candidate was polled again');
      return value.transport.api(path, signal);
    },
    buildInfo: expectNoCall, promote: expectNoCall, versionAlias: { read: expectNoCall, assign: expectNoCall },
  };
  return { requests, candidatePath, expectNoCall, status: () => runRelease({ command: 'status', cwd: value.cwd, sha: value.sha, transport }) };
}

it.each(['none', 'alias', 'promote'] as const)('reports the blocked candidate with the original %s effect evidence', async pending => {
  const value = await fixture(pending !== 'promote');
  const lost = () => { throw new ReleaseError('VERCEL_API'); };
  if (pending === 'none') value.hooks.deployment = { readyState: 'ERROR' };
  else if (pending === 'alias') value.hooks.alias = lost;
  else value.hooks.promote = lost;
  const published = await runRelease({ command: 'publish', cwd: value.cwd, transport: value.transport });
  expect(published, JSON.stringify(published.error)).toMatchObject({ ok: false, processes: { status: 'closed' },
    effects: { deploymentCreate: 'accepted', deploymentPromote: pending === 'promote' ? 'unknown' : 'not-attempted',
      ...(pending !== 'promote' ? { versionAliasAssign: pending === 'alias' ? 'unknown' : 'not-attempted' } : {}) },
    prebuilt: { deploymentId: 'dpl_candidate' }, runId: expect.any(String) });
  const slot = resolve(value.cwd, 'state/release-slot');
  const files = ['latest-publish.json', 'state.json', `history/${published.runId}.json`].map(file => resolve(slot, file));
  const originals = await Promise.all(files.map(file => readFile(file)));
  const probe = observe(value, { ...blocked, seatBlock: { blockCode: 'TEAM_ACCESS_REQUIRED', userId: 'unreported-user' },
    readyStateReason: 'unreported-provider-text' });
  const report = await probe.status();
  expect(report, JSON.stringify(report.error)).toMatchObject({ schemaVersion: 2, command: 'status', ok: false, stage: 'deployment',
    candidateSha: value.sha, configSha256: published.configSha256, runId: published.runId, prebuilt: published.prebuilt,
    effects: published.effects, steps: [], processes: { status: 'closed' },
    deployment: { id: 'dpl_candidate', url: 'https://candidate.vercel.app', sha: value.sha, projectId: 'prj_fixture', state: 'BLOCKED' },
    error: { code: 'DEPLOYMENT_FAILED', details: { deploymentId: 'dpl_candidate', state: 'BLOCKED', observedAt: expect.any(String), providerBlockCode: 'TEAM_ACCESS_REQUIRED' } } });
  expect(report.candidateContext).toEqual(published.candidateContext);
  expect(report.effects).toEqual(published.effects);
  expect(report.prebuilt).toEqual(published.prebuilt);
  const sampleTime = Date.parse(String(report.error?.details.observedAt));
  expect(sampleTime).toBeGreaterThanOrEqual(Date.parse(report.startedAt));
  expect(sampleTime).toBeLessThanOrEqual(Date.parse(report.finishedAt));
  expect(JSON.stringify(report)).not.toContain('unreported-');
  expect(probe.requests).toEqual(['/v9/projects/prj_fixture?teamId=team_fixture', probe.candidatePath]);
  expect(probe.expectNoCall).not.toHaveBeenCalled();

  if (pending === 'none') {
    for (const state of ['BLOCKED', 'ERROR', 'CANCELED', 'CANCELLED']) {
      const observed = observe(value, { readyState: state, seatBlock: { blockCode: state === 'BLOCKED' ? 'unrecognized-code' : 'TEAM_ACCESS_REQUIRED' } });
      const result = await observed.status();
      expect(result).toMatchObject({ ok: false, deployment: { id: 'dpl_candidate', state },
        error: { code: 'DEPLOYMENT_FAILED', details: { deploymentId: 'dpl_candidate', state, observedAt: expect.any(String) } } });
      expect(result.error?.details).not.toHaveProperty('providerBlockCode');
      expect(observed.requests).toHaveLength(2);
      expect(observed.expectNoCall).not.toHaveBeenCalled();
    }
    const author = observe(value, { ...blocked, seatBlock: { blockCode: 'COMMIT_AUTHOR_REQUIRED' } });
    expect(await author.status()).toMatchObject({ error: { code: 'DEPLOYMENT_FAILED', details: { providerBlockCode: 'COMMIT_AUTHOR_REQUIRED' } } });
    expect(author.requests).toHaveLength(2);
    expect(author.expectNoCall).not.toHaveBeenCalled();
    for (const identity of [{ id: 'dpl_other' }, { ownerId: 'team_other' }, { projectId: 'prj_other' },
      { target: 'preview' }, { source: 'git' }, { url: 'other.vercel.app' }]) {
      const rejected = await observe(value, { ...blocked, ...identity }).status();
      expect(rejected).toMatchObject({ ok: false, error: { code: 'DEPLOYMENT_SOURCE' } });
      expect(rejected.deployment).toBeUndefined();
    }
  }
  expect(await Promise.all(files.map(file => readFile(file)))).toEqual(originals);
  expect(await value.creates()).toBe(1);
  expect(value.promotions()).toBe(pending === 'promote' ? 1 : 0);
  expect(value.assignments()).toBe(pending === 'alias' ? 1 : 0);
}, 300_000);
