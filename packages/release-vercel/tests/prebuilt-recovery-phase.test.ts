import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ReleaseError } from '../src/node/errors.js';
import { assertManagedRemoteSettled } from '../src/node/managed-remote-state.js';
import { recordVerifiedAlias, resumeVerifiedAlias } from '../src/node/prebuilt-resumption.js';
import * as recovery from '../src/node/managed-recovery.js';
import { Execution } from '../src/node/execution.js';
import { prebuiltPhaseFixture } from './helpers/prebuilt-phase-fixture.js';

vi.mock('../src/node/managed-recovery.js', async original => ({ ...await original<typeof recovery>() }));
const owned: Awaited<ReturnType<typeof prebuiltPhaseFixture>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const value of owned.splice(0)) await value.dispose(); });
async function fixture(withAlias = false) {
  const value = await prebuiltPhaseFixture({ withAlias }); owned.push(value);
  vi.spyOn(recovery, 'assertHistoricalSource').mockImplementation(async source => { expect(source).toEqual(value.source); });
  vi.spyOn(Execution.prototype, 'run').mockImplementation(async () => { throw new Error('phase protocol must not launch application commands'); });
  vi.spyOn(Execution.prototype, 'git').mockImplementation(async () => { throw new Error('phase protocol must not launch Git'); });
  return value;
}

it('refuses another creation after an unknown create even when the phase source advances', async () => {
  const value = await fixture();
  Object.assign(value.engine.hooks, { created: () => { throw new ReleaseError('VERCEL_API'); } });
  await expect(value.publish()).rejects.toMatchObject({ code: 'VERCEL_API' });
  expect(value.session.state.prebuilt).toMatchObject({ createEffect: 'unknown' });
  expect(value.session.state.prebuilt?.deploymentId).toBeUndefined();
  await value.archive(false); await value.next('publish', 'b'.repeat(40));
  await expect(assertManagedRemoteSettled(value.session.slot.paths, value.session.execution, undefined, value.transport))
    .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED', details: { reason: 'PREBUILT_CREATE_UNKNOWN' } });
  expect(value.engine.counts()).toEqual({ creates: 1, promotions: 0 });
  expect(value.session.state.processes).toEqual([]);
});

it.each(['lost-response', 'failed-job'] as const)('keeps a proved old promotion settled across two later phase candidates: %s', async kind => {
  const value = await fixture();
  if (kind === 'lost-response') value.hooks.promote = () => { throw new ReleaseError('VERCEL_API'); };
  else value.hooks.failPromotion = true;
  await expect(value.publish()).rejects.toBeInstanceOf(ReleaseError);
  expect(value.session.state.prebuilt).toMatchObject({ promoteEffect: kind === 'lost-response' ? 'unknown' : 'accepted', promotionVerified: false });
  const original = structuredClone(value.session.state), receipt = await value.archive(false);
  const path = resolve(value.session.slot.paths.slotRoot, 'history', `${original.runId}.json`), before = await readFile(path);
  delete value.hooks.promote;
  await value.next('publish', 'b'.repeat(40));
  await assertManagedRemoteSettled(value.session.slot.paths, value.session.execution, undefined, value.transport, async proof => {
    value.session.state.prebuiltResolutions = [proof]; await value.session.persist();
  });
  expect(value.session.state.prebuiltResolutions).toEqual([expect.objectContaining({ runId: receipt.report.runId,
    sourceSha: value.sha, deploymentId: 'dpl_candidate', promotion: kind === 'lost-response' ? 'succeeded' : 'failed' })]);
  const candidate = original.prebuilt; if (!candidate) throw new Error('original candidate required');
  value.session.state.prebuilt = { ...candidate, sourceSha: 'b'.repeat(40), deploymentId: 'dpl_second', deploymentUrl: 'https://second.vercel.app',
    createEffect: 'accepted', promoteEffect: 'accepted', acceptanceVerified: true, promotionVerified: true };
  Object.assign(value.session.state.effects, { deploymentCreate: 'accepted', deploymentPromote: 'accepted' });
  await value.archive(true); await value.next('publish', 'c'.repeat(40));
  const noCloud = { ...value.transport, api: async () => { throw new Error('a resolved historical alias was queried after a later promotion'); },
    buildInfo: async () => { throw new Error('a resolved historical artifact was queried again'); } };
  await expect(assertManagedRemoteSettled(value.session.slot.paths, value.session.execution, undefined, noCloud)).resolves.toBeUndefined();
  expect(await readFile(path)).toEqual(before);
  expect(value.session.state.history).toHaveLength(2);
  expect(value.session.state.processes).toEqual([]);
});

it.each(['unknown', 'accepted'] as const)('resumes the same candidate only after an archived readonly proof of an %s alias', async effect => {
  const value = await fixture(true);
  if (effect === 'unknown') value.hooks.alias = () => { throw new ReleaseError('VERCEL_API'); };
  else value.hooks.versionRead = () => { throw new ReleaseError('BUILD_INFO', { status: 503 }); };
  await expect(value.publish()).rejects.toBeInstanceOf(ReleaseError);
  expect(value.session.state.prebuilt).toMatchObject({ deploymentId: 'dpl_candidate', versionAlias: { effect, verified: false } });
  const original = structuredClone(value.session.state), receipt = await value.archive(false);
  const receiptPath = resolve(value.session.slot.paths.slotRoot, 'latest-publish.json'), before = await readFile(receiptPath);
  delete value.hooks.alias; delete value.hooks.versionRead;
  await value.next('verify');
  await recordVerifiedAlias(value.session, receipt, value.transport);
  expect(value.session.state.prebuiltResolutions).toEqual([expect.objectContaining({ runId: original.runId, sourceSha: value.sha,
    configSha256: value.source.configSha256, artifactSha256: original.prebuilt?.artifactSha256,
    versionAlias: { hostname: `fixture-${value.sha}.vercel.app`, verified: true } })]);
  expect(await readFile(receiptPath)).toEqual(before);
  expect(value.engine.counts()).toEqual({ creates: 1, promotions: 0 });
  await value.archive(true); await value.next('publish');
  const resumed = await resumeVerifiedAlias(value.session, receipt); expect(resumed).toBeDefined();
  if (!resumed) throw new Error('explicit verification proof required');
  value.session.state.prebuilt = resumed.candidate; value.session.state.prebuiltResolutions = [resumed.proof];
  Object.assign(value.session.state.effects, { deploymentCreate: 'accepted', deploymentPromote: 'not-attempted', versionAliasAssign: 'accepted' });
  await value.session.persist(); await value.publish();
  expect(value.session.state.prebuilt).toMatchObject({ deploymentId: 'dpl_candidate', promotionVerified: true });
  expect(value.engine.counts()).toEqual({ creates: 1, promotions: 1 }); expect(value.assignments()).toBe(1);
  expect(await readFile(receiptPath)).toEqual(before);
  const archive = JSON.parse(await readFile(resolve(value.session.slot.paths.slotRoot, 'history', `${original.runId}.json`), 'utf8'));
  expect(archive.stopped.prebuilt.versionAlias).toMatchObject({ effect, verified: false });
  expect(value.session.state.processes).toEqual([]);
});
