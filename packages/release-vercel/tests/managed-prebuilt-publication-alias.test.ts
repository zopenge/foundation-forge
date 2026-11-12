import { fixture } from './helpers/prebuilt-publication-fixture.js';
import { runRelease } from '../src/node.js';
import { ReleaseError } from '../src/node/errors.js';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('managed prebuilt candidate recovery through public entry', () => {
it('persists alias uncertainty, exposes readonly context, and proves the original binding before a new candidate', async () => {
    const value = await fixture(true);
    value.hooks.alias = () => { throw new ReleaseError('VERCEL_API'); };
    const first = await runRelease({ command: 'publish', cwd: value.cwd, transport: value.transport });
    expect(first, JSON.stringify(first.error)).toMatchObject({ ok: false, error: { code: 'VERCEL_API' },
      prebuilt: { deploymentId: 'dpl_candidate', versionAlias: { effect: 'unknown', verified: false } },
      effects: { versionAliasAssign: 'unknown' } });
    const receipt = resolve(value.cwd, 'state/release-slot/latest-publish.json');
    const before = await readFile(receipt);
    let verificationRunId = '';
    for (const command of ['status', 'verify'] as const) {
      const observed = await runRelease({ command, cwd: value.cwd, transport: value.transport });
      expect(observed, JSON.stringify(observed.error)).toMatchObject({ ok: true, candidateContext: {
        teamId: 'team_fixture', projectId: 'prj_fixture', sourceSha: value.sha, deploymentId: 'dpl_candidate',
        versionUrl: `https://fixture-${value.sha}.vercel.app`, versionAliasVerified: true,
        configSha256: first.configSha256, artifactSha256: first.prebuilt?.artifactSha256,
      } });
      if (command === 'verify') verificationRunId = observed.runId ?? '';
    }
    expect(await readFile(receipt)).toEqual(before);
    expect(await value.creates()).toBe(1); expect(value.assignments()).toBe(1); expect(value.promotions()).toBe(0);
    delete value.hooks.alias;
    await writeFile(resolve(value.cwd, 'source.txt'), 'new alias candidate\n'); const nextSha = value.commit();
    expect(verificationRunId).toMatch(/^[a-f0-9-]{36}$/u);
    let proofCheckedBeforeCreate = false;
    value.hooks.project = async () => {
      expect(await value.creates()).toBe(1);
      const archive = JSON.parse(await readFile(resolve(value.cwd, `state/release-slot/history/${verificationRunId}.json`), 'utf8'));
      expect(archive).toMatchObject({ stopped: { runId: verificationRunId, command: 'verify' }, outcome: { ok: true } });
      expect(archive.stopped.prebuiltResolutions).toEqual(expect.arrayContaining([expect.objectContaining({ runId: first.runId,
        sourceSha: value.sha, configSha256: first.configSha256, artifactSha256: first.prebuilt?.artifactSha256, deploymentId: 'dpl_candidate',
        versionAlias: { hostname: `fixture-${value.sha}.vercel.app`, verified: true } })]));
      proofCheckedBeforeCreate = true; delete value.hooks.project;
    };
    const next = await runRelease({ command: 'publish', cwd: value.cwd, transport: value.transport });
    expect(next, JSON.stringify(next.error)).toMatchObject({ ok: true, candidateSha: nextSha,
      candidateContext: { deploymentId: 'dpl_candidate2', versionAliasVerified: true } });
    expect(await value.creates()).toBe(2); expect(value.assignments()).toBe(2); expect(value.promotions()).toBe(1);
    expect(proofCheckedBeforeCreate).toBe(true);
    expect(value.versionBindings.get(`fixture-${value.sha}.vercel.app`)).toBe('dpl_candidate');
  }, 300_000);
});
