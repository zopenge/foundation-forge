import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ReleaseError } from '../src/node/errors.js';
import { archiveManagedDisposition, discardIsolatedCheckout } from '../src/node/managed-disposition.js';
import { fileIdentity } from '../src/node/managed-io.js';
import { assertManagedRemoteSettled } from '../src/node/managed-remote-state.js';
import { observePrebuiltCandidate } from '../src/node/prebuilt-recovery.js';
import { createPrebuiltTransport } from '../src/node/prebuilt-vercel.js';
import { canResealPrebuilt, recordVerifiedAlias, resumeVerifiedAlias, selectPrebuiltContinuation } from '../src/node/prebuilt-resumption.js';
import { loadManagedPublication } from '../src/node/managed-recovery.js';
import * as sourceBinding from '../src/node/source.js';
import { Execution } from '../src/node/execution.js';
import { prebuiltPhaseFixture } from './helpers/prebuilt-phase-fixture.js';

vi.mock('../src/node/source.js', async original => ({ ...await original<typeof sourceBinding>() }));
const owned: Awaited<ReturnType<typeof prebuiltPhaseFixture>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const value of owned.splice(0)) await value.dispose(); });
async function fixture(withAlias = false) {
  const value = await prebuiltPhaseFixture({ withAlias }); owned.push(value);
  vi.spyOn(sourceBinding, 'assertHistoricalSource').mockImplementation(async source => { expect(source).toEqual(value.source); });
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
  const receipt = await value.archive(false); await value.next('publish');
  await expect(canResealPrebuilt(value.session, receipt)).resolves.toBe(false);
  await value.next('publish', 'b'.repeat(40));
  await expect(assertManagedRemoteSettled(value.session.slot.paths, value.session.execution, undefined, value.transport))
    .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED', details: { reason: 'PREBUILT_CREATE_UNKNOWN' } });
  expect(value.engine.counts()).toEqual({ creates: 1, promotions: 0 });
  expect(value.session.state.processes).toEqual([]);
});

it.each(['accepted', 'unknown'] as const)('keeps an earlier %s remote effect pinned across a stopped candidate with no effects', async effect => {
  const value = await fixture();
  if (effect === 'accepted') await value.publish();
  else {
    value.engine.hooks.created = () => { throw new ReleaseError('VERCEL_API'); };
    await expect(value.publish()).rejects.toMatchObject({ code: 'VERCEL_API' });
  }
  const prior = await value.archive(effect === 'accepted');
  expect(prior.report.prebuilt?.createEffect).toBe(effect);
  await value.next('publish');
  value.engine.hooks.run = name => { if (name === 'admission:create:0') throw new ReleaseError('ADMISSION_FAILED'); };
  await expect(value.publish()).rejects.toMatchObject({ code: 'ADMISSION_FAILED' });
  const receipt = await value.archive(false);
  expect(Object.values(receipt.report.effects).every(value => value === 'not-attempted')).toBe(true);
  await value.next('publish');
  await expect(canResealPrebuilt(value.session, receipt)).resolves.toBe(false);
  expect(value.engine.counts().creates).toBe(1);
});

it('allows resealing in the same slot once recovery has discarded the stopped unpublished checkout', async () => {
  const value = await fixture();
  value.engine.hooks.run = name => { if (name === 'admission:create:0') throw new ReleaseError('ADMISSION_FAILED'); };
  await expect(value.publish()).rejects.toMatchObject({ code: 'ADMISSION_FAILED' });
  const { slot, state } = value.session;
  state.checkoutIdentity = await fileIdentity(slot.paths.checkoutRoot);
  state.status = 'closed';
  await value.session.persist();
  const receipt = value.report(false);
  await slot.store.writeReceipt('publish', receipt);
  await expect(canResealPrebuilt(value.session, receipt)).resolves.toBe(false);

  const guard = () => slot.lock.assertOwned();
  // 生产 recovery 取得声明时创建隔离目录，此处直接验证归档及其后的丢弃阶段。
  await mkdir(resolve(slot.paths.slotRoot, 'retirement-work'));
  const evidence = await archiveManagedDisposition(slot.paths, state, state, guard, undefined, false, undefined,
    { ...state.checkoutIdentity, quarantineId: randomUUID() });
  const assertDiscarded = await discardIsolatedCheckout(slot.paths, evidence, guard, true);
  await assertDiscarded();
  await value.next('publish');
  expect(value.session.slot.paths).toEqual(slot.paths);
  await expect(canResealPrebuilt(value.session, receipt)).resolves.toBe(true);
  expect(value.engine.counts()).toEqual({ creates: 0, promotions: 0 });
});

it('selects an archived accepted intent after interruption before a receipt was written', async () => {
  const value = await fixture();
  value.engine.hooks.api = (path, response) => {
    if (path.startsWith('/v13/deployments/')) throw new ReleaseError('VERCEL_API');
    return response;
  };
  await expect(value.publish()).rejects.toMatchObject({ code: 'VERCEL_API' });
  const { slot, state } = value.session, candidate = state.prebuilt;
  if (!candidate?.deploymentId) throw new Error('staged candidate required');
  state.checkoutIdentity = await fileIdentity(slot.paths.checkoutRoot); state.status = 'closed';
  await value.session.persist();
  const binding = { runId: state.runId, sha: candidate.sourceSha, configSha256: candidate.configSha256,
    artifactSha256: candidate.artifactSha256, deploymentId: candidate.deploymentId };
  await slot.store.writeAnchor({ schemaVersion: 2, slotId: slot.slotId, slotPath: slot.paths.slotRoot,
    configPath: value.source.configPath, sourceRoot: value.cwd,
    latestPublish: { runId: binding.runId, sha: binding.sha, configSha256: binding.configSha256 } });
  await archiveManagedDisposition(slot.paths, state, state, () => slot.lock.assertOwned());
  await value.next('publish');
  const selected = await loadManagedPublication(value.cwd, value.source.configPath, binding.sha);
  expect(selected).toMatchObject({ reportExists: false, receipt: { report: { runId: binding.runId, prebuilt: candidate } } });
  await expect(selectPrebuiltContinuation(value.session.slot, binding, selected.receipt, undefined, selected.reportExists))
    .resolves.toMatchObject({ checkout: state.checkoutIdentity });
});

it('observes staged readiness while an original version alias is still unattempted', async () => {
  const value = await fixture(true);
  value.engine.hooks.api = (path, response) => {
    if (path.startsWith('/v13/deployments/')) throw new ReleaseError('VERCEL_API');
    return response;
  };
  await expect(value.publish()).rejects.toMatchObject({ code: 'VERCEL_API' });
  delete value.engine.hooks.api;
  const adapter = value.transport.versionAlias;
  if (!adapter) throw new Error('fixture version alias transport required');
  const read = vi.spyOn(adapter, 'read');
  const access = createPrebuiltTransport(value.session.execution, value.config, false, undefined, value.transport);
  await expect(observePrebuiltCandidate(value.config, value.session.state.prebuilt, access, undefined, 'status'))
    .resolves.toMatchObject({ deployment: { id: 'dpl_candidate', state: 'READY' }, observed: { versionAlias: { effect: 'not-attempted' } } });
  expect(read).not.toHaveBeenCalled();
  expect(value.assignments()).toBe(0);
});

it.each(['accepted', 'unknown'] as const)('observes an existing %s promotion without executing release commands', async effect => {
  const value = await fixture();
  if (effect === 'unknown') {
    value.hooks.promote = () => { throw new ReleaseError('VERCEL_API'); };
    await expect(value.publish()).rejects.toMatchObject({ code: 'VERCEL_API' });
  } else await value.publish();
  const receipt = await value.archive(effect === 'accepted');
  const candidate = receipt.report.prebuilt;
  if (!candidate) throw new Error('promotion candidate required');
  expect(candidate.promoteEffect).toBe(effect);
  await value.next('publish');
  value.session.state.prebuilt = structuredClone(candidate);
  value.session.state.effects = { ...receipt.report.effects };
  await value.session.persist();
  value.engine.hooks.run = name => { throw new Error(`unexpected resumed command ${name}`); };
  await expect(value.publish(true)).resolves.toMatchObject({ id: 'dpl_candidate' });
  expect(value.session.state.prebuilt).toMatchObject({ promoteEffect: 'accepted', promotionVerified: true });
  expect(value.engine.counts()).toEqual({ creates: 1, promotions: 1 });
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
