import { afterEach, expect, it } from 'vitest';
import { publishCandidate } from '../src/node/publication.js';
import { ReleaseError } from '../src/node/errors.js';
import { versionAliasFixture } from './helpers/version-alias-fixture.js';

const fixtures: Awaited<ReturnType<typeof versionAliasFixture>>[] = [];
async function fixture() { const value = await versionAliasFixture(); fixtures.push(value); return value; }
afterEach(async () => { for (const value of fixtures.splice(0)) await value.dispose(); });

it('binds the version hostname once, verifies its route, then accepts and promotes the same candidate', async () => {
  const value = await fixture(); let contextJson = '';
  value.hooks.run = (name, env) => { if (name === 'acceptance:0') contextJson = env?.FORGE_RELEASE_CANDIDATE_CONTEXT ?? ''; };
  await expect(publishCandidate(value.context, 'publish')).resolves.toMatchObject({ id: 'dpl_candidate' });
  expect(value.aliasWrites()).toBe(1);
  expect(value.prebuilt.state?.versionAlias).toEqual({ hostname: value.hostname, effect: 'accepted', verified: true });
  expect(value.effects.versionAliasAssign).toBe('accepted');
  expect(JSON.parse(contextJson)).toEqual({ teamId: 'team_fixture', projectId: 'prj_fixture', sourceSha: 'a'.repeat(40),
    configSha256: value.prebuilt.state?.configSha256, artifactSha256: value.prebuilt.state?.artifactSha256,
    deploymentId: 'dpl_candidate', candidateUrl: 'https://candidate.vercel.app',
    versionUrl: `https://${value.hostname}`, versionAliasVerified: true });
  expect(value.trace.indexOf('alias-assign')).toBeLessThan(value.trace.indexOf(`read:${value.hostname}`));
  expect(value.trace.indexOf(`read:${value.hostname}`)).toBeLessThan(value.trace.indexOf('run:acceptance:0'));
  expect(value.trace.indexOf('run:acceptance:0')).toBeLessThan(value.trace.indexOf('promote'));
});

it('rejects an occupied hostname before creating another candidate', async () => {
  const value = await fixture();
  value.bindings.set(value.hostname, { alias: value.hostname, projectId: 'prj_fixture', deploymentId: 'dpl_other', routing: 'direct' });
  await expect(publishCandidate(value.context, 'publish')).rejects.toMatchObject({ code: 'VERSION_ALIAS_CONFLICT' });
  expect(value.counts()).toEqual({ creates: 0, promotions: 0 }); expect(value.aliasWrites()).toBe(0);
});

it('only reads an existing exact-candidate binding and never resubmits the alias assignment', async () => {
  const value = await fixture();
  value.hooks.run = name => { if (name === 'prebuilt-create') value.bindings.set(value.hostname,
    { alias: value.hostname, projectId: 'prj_fixture', deploymentId: 'dpl_candidate', routing: 'direct' }); };
  await publishCandidate(value.context, 'publish');
  expect(value.aliasWrites()).toBe(0); expect(value.prebuilt.state?.versionAlias?.verified).toBe(true);
  expect(value.counts()).toEqual({ creates: 1, promotions: 1 });
});

it.each(['deployment', 'project', 'routing'])('rejects a conflicting binding discovered after staging: %s', async kind => {
  const value = await fixture();
  value.hooks.run = name => { if (name === 'prebuilt-create') value.bindings.set(value.hostname, {
    alias: value.hostname, projectId: kind === 'project' ? 'prj_other' : 'prj_fixture',
    deploymentId: kind === 'deployment' ? 'dpl_other' : 'dpl_candidate', routing: 'direct',
    ...(kind === 'routing' ? { redirect: 'elsewhere.vercel.app' } : {}) }); };
  await expect(publishCandidate(value.context, 'publish')).rejects.toMatchObject({ code: 'VERSION_ALIAS_CONFLICT' });
  expect(value.aliasWrites()).toBe(0); expect(value.counts().promotions).toBe(0);
});

it('does not treat authentication failure as an unoccupied hostname', async () => {
  const value = await fixture(); value.aliasHooks.read = () => { throw new ReleaseError('AUTH_REQUIRED'); };
  await expect(publishCandidate(value.context, 'publish')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  expect(value.counts()).toEqual({ creates: 0, promotions: 0 }); expect(value.aliasWrites()).toBe(0);
});

it('retains an unknown alias after a lost response and only resolves it through read-only verification', async () => {
  const value = await fixture();
  value.aliasHooks.assign = async () => { throw new ReleaseError('VERCEL_API'); };
  await expect(publishCandidate(value.context, 'publish')).rejects.toMatchObject({ code: 'VERCEL_API' });
  expect(value.prebuilt.state?.versionAlias?.effect).toBe('unknown');
  await expect(publishCandidate(value.context, 'publish')).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  expect(value.counts().promotions).toBe(0); expect(value.aliasWrites()).toBe(1);
  await expect(publishCandidate(value.context, 'verify')).resolves.toMatchObject({ id: 'dpl_candidate' });
  expect(value.prebuilt.state?.versionAlias).toMatchObject({ effect: 'accepted', verified: true });
  expect(value.counts().promotions).toBe(0); expect(value.aliasWrites()).toBe(1);
  await publishCandidate(value.context, 'publish');
  expect(value.counts()).toEqual({ creates: 1, promotions: 1 }); expect(value.aliasWrites()).toBe(1);
});

it('does not repair an alias missing after an unknown write', async () => {
  const value = await fixture();
  value.aliasHooks.assign = async host => { value.bindings.delete(host); throw new ReleaseError('VERCEL_API'); };
  await expect(publishCandidate(value.context, 'publish')).rejects.toMatchObject({ code: 'VERCEL_API' });
  await expect(publishCandidate(value.context, 'verify')).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  await expect(publishCandidate(value.context, 'publish')).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  expect(value.aliasWrites()).toBe(1); expect(value.counts().promotions).toBe(0);
});

it('retains a committed intent when interrupted before sending the alias request', async () => {
  const value = await fixture(), save = value.prebuilt.save.bind(value.prebuilt);
  value.prebuilt.save = async state => { await save(state); if (state.versionAlias?.effect === 'unknown') throw new ReleaseError('CANCELLED'); };
  await expect(publishCandidate(value.context, 'publish')).rejects.toMatchObject({ code: 'CANCELLED' });
  await expect(publishCandidate(value.context, 'publish')).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  expect(value.aliasWrites()).toBe(0); expect(value.prebuilt.state?.versionAlias?.effect).toBe('unknown');
});

it('detects a version alias moved during promotion without rewriting it', async () => {
  const value = await fixture(); value.hooks.promote = () => { value.bindings.set(value.hostname,
    { alias: value.hostname, projectId: 'prj_fixture', deploymentId: 'dpl_other', routing: 'direct' }); };
  await expect(publishCandidate(value.context, 'publish')).rejects.toMatchObject({ code: 'VERSION_ALIAS_CONFLICT' });
  expect(value.aliasWrites()).toBe(1); expect(value.bindings.get(value.hostname)?.deploymentId).toBe('dpl_other');
});

it('does not send an alias request when its intent cannot be persisted', async () => {
  const value = await fixture(), save = value.prebuilt.save.bind(value.prebuilt);
  value.prebuilt.save = async state => {
    if (state.versionAlias?.effect === 'unknown') throw new ReleaseError('IO_FAILED');
    await save(state);
  };
  await expect(publishCandidate(value.context, 'publish')).rejects.toMatchObject({ code: 'IO_FAILED' });
  expect(value.aliasWrites()).toBe(0); expect(value.counts()).toEqual({ creates: 1, promotions: 0 });
});

it('retains uncertainty when the platform reports a different old deployment', async () => {
  const value = await fixture();
  value.aliasHooks.assign = async hostname => ({ alias: hostname, uid: 'fixtureAlias', oldDeploymentId: 'dpl_external' });
  await expect(publishCandidate(value.context, 'publish')).rejects.toMatchObject({ code: 'VERSION_ALIAS_CONFLICT',
    details: { reason: 'EXTERNAL_REBIND_REPORTED' } });
  expect(value.prebuilt.state?.versionAlias?.effect).toBe('unknown');
  await expect(publishCandidate(value.context, 'publish')).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  expect(value.aliasWrites()).toBe(1); expect(value.counts().promotions).toBe(0);
});

it('cancels an alias write without replay or promotion', async () => {
  const value = await fixture(); value.aliasHooks.assign = async () => { value.controller.abort(); throw new ReleaseError('CANCELLED'); };
  await expect(publishCandidate(value.context, 'publish')).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(value.prebuilt.state?.versionAlias?.effect).toBe('unknown');
  expect(value.aliasWrites()).toBe(1); expect(value.counts().promotions).toBe(0);
});

it('waits for the version route after one assignment', async () => {
  const value = await fixture(), transport = value.context.transport;
  if (!transport) throw new Error('transport required');
  const read = transport.buildInfo; let missing = 2;
  Object.assign(transport, { buildInfo: async (url: string, signal: AbortSignal) => {
    if (new URL(url).hostname === value.hostname && missing-- > 0) throw new ReleaseError('BUILD_INFO', { status: 404 });
    return read(url, signal);
  } });
  await publishCandidate(value.context, 'publish');
  expect(value.aliasWrites()).toBe(1); expect(value.counts().promotions).toBe(1);
});

it('stops immediately at an incorrect version marker and never runs acceptance', async () => {
  const value = await fixture(), transport = value.context.transport;
  if (!transport) throw new Error('transport required');
  const read = transport.buildInfo; let wrongReads = 0;
  Object.assign(transport, { buildInfo: async (url: string, signal: AbortSignal) => {
    if (new URL(url).hostname === value.hostname) { wrongReads++; return { schemaVersion: 1, sourceSha: 'b'.repeat(40) }; }
    return read(url, signal);
  } });
  await expect(publishCandidate(value.context, 'publish')).rejects.toMatchObject({ code: 'ARTIFACT_CHANGED' });
  expect(wrongReads).toBe(1); expect(value.trace).not.toContain('run:acceptance:0');
  expect(value.aliasWrites()).toBe(1); expect(value.counts().promotions).toBe(0);
});

it('rechecks the version binding after consumer admission and before promotion', async () => {
  const value = await fixture();
  value.hooks.run = name => { if (name === 'admission:promote:0') value.bindings.set(value.hostname,
    { alias: value.hostname, projectId: 'prj_fixture', deploymentId: 'dpl_external', routing: 'direct' }); };
  await expect(publishCandidate(value.context, 'publish')).rejects.toMatchObject({ code: 'VERSION_ALIAS_CONFLICT' });
  expect(value.aliasWrites()).toBe(1); expect(value.counts().promotions).toBe(0);
});
