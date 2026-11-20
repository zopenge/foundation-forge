import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReleaseConfig } from '../src/contracts.js';
import { ReleaseError } from '../src/node/errors.js';
import { assertManagedRemoteSettled } from '../src/node/managed-remote-state.js';
import * as sourceBinding from '../src/node/source.js';
import { Execution } from '../src/node/execution.js';
import { prebuiltPhaseFixture } from './helpers/prebuilt-phase-fixture.js';
import { observePrebuiltCandidate } from '../src/node/prebuilt-recovery.js';
import { createPrebuiltTransport } from '../src/node/prebuilt-vercel.js';

vi.mock('../src/node/source.js', async original => ({ ...await original<typeof sourceBinding>() }));
const owned: Awaited<ReturnType<typeof prebuiltPhaseFixture>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const value of owned.splice(0)) await value.dispose(); });
async function fixture(withAlias = false, completion?: ReleaseConfig['completion']) {
  const value = await prebuiltPhaseFixture({ withAlias, ...(completion ? { completion } : {}) }); owned.push(value);
  vi.spyOn(sourceBinding, 'assertHistoricalSource').mockImplementation(async source => { expect(source).toEqual(value.source); });
  vi.spyOn(Execution.prototype, 'run').mockImplementation(async () => { throw new Error('phase protocol must not launch application commands'); });
  vi.spyOn(Execution.prototype, 'git').mockImplementation(async () => { throw new Error('phase protocol must not launch Git'); });
  return value;
}

async function archivePromotionVerification(mode: 'complete' | 'missing' | 'failed' | 'incomplete' | 'incomplete-completion'
  | 'other-completion-run' | 'wrong-source' | 'wrong-artifact' | 'wrong-candidate' | 'unbound' | 'replaced-receipt') {
  const withCompletion = mode === 'incomplete-completion' || mode === 'other-completion-run';
  const value = await fixture(false, withCompletion ? { idempotent: true, jobs: [{ command: 'node', args: ['-e', 'process.exit(0)'] }] } : undefined);
  value.hooks.promote = () => { throw new ReleaseError('VERCEL_API', { status: 201 }); };
  await expect(value.publish()).rejects.toMatchObject({ code: 'VERCEL_API', details: { status: 201 } });
  const published = await value.archive(false), candidate = published.report.prebuilt;
  if (!candidate) throw new Error('missing promotion intent');
  const completionInput = value.session.state.completionInput;
  const paths = value.session.slot.paths;
  const originPath = resolve(paths.slotRoot, 'history', `${value.session.state.runId}.json`);
  const original = await readFile(originPath);
  const receiptPath = resolve(paths.slotRoot, 'latest-publish.json'), receipt = await readFile(receiptPath);
  const frozen = await observePrebuiltCandidate(value.config, candidate,
    createPrebuiltTransport(value.session.execution, value.config, false, undefined, value.transport));
  if (mode === 'complete') {
    await value.next('verify');
    value.session.state.prebuilt = structuredClone(candidate);
    value.session.state.effects = structuredClone(published.report.effects);
    value.session.state.stage = 'acceptance';
    await value.archive(false);
  }
  let verification: { path: string; bytes: Buffer } | undefined;
  if (mode !== 'missing') {
    const withheld = resolve(value.root, 'withheld.json');
    if (mode === 'unbound') await rename(originPath, withheld);
    if (mode === 'replaced-receipt') {
      await rename(receiptPath, withheld);
      await writeFile(receiptPath, receipt);
    }
    try { await value.next('verify', mode === 'wrong-source' ? 'b'.repeat(40) : value.sha); }
    finally { if (mode === 'unbound') await rename(withheld, originPath); }
    const state = value.session.state, deployment = { ...frozen.deployment, sha: state.source.sha,
      ...(mode === 'wrong-candidate' ? { id: 'dpl_other' } : {}) };
    state.prebuilt = { ...frozen.observed, sourceSha: state.source.sha, deploymentId: deployment.id,
      ...(mode === 'wrong-artifact' ? { artifactSha256: 'd'.repeat(64) } : {}) };
    Object.assign(state.effects, { deploymentCreate: 'accepted', deploymentPromote: 'accepted' });
    state.stage = mode === 'incomplete' ? 'acceptance' : 'complete';
    if (withCompletion) {
      if (!published.report.completion || !completionInput) throw new Error('missing completion intent');
      state.completion = published.report.completion; state.completionInput = completionInput;
      if (mode === 'other-completion-run') {
        const timing = { startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 0 };
        state.completion = { ...state.completion, status: 'completed', attempts: [{ ...timing, runId: randomUUID(), status: 'completed',
          jobs: [{ ...timing, index: 0, status: 'completed', commandId: randomUUID() }] }] };
      }
    }
    if (mode === 'failed' && published.report.runId && candidate.deploymentId) state.prebuiltResolutions = [{ schemaVersion: 1,
      runId: published.report.runId, sourceSha: candidate.sourceSha, configSha256: candidate.configSha256, artifactSha256: candidate.artifactSha256,
      deploymentId: candidate.deploymentId, promotion: 'succeeded', observedAt: new Date().toISOString() }];
    await value.archive(mode !== 'failed', deployment);
    const path = resolve(paths.slotRoot, 'history', `${state.runId}.json`);
    verification = { path, bytes: await readFile(path) };
  }
  await value.next('publish', 'c'.repeat(40));
  const readOldMarker = vi.fn(async () => { throw new ReleaseError('VERCEL_API', { reason: 'REQUEST_TIMEOUT' }); });
  const resolveOldEffect = vi.fn(async (proof: NonNullable<typeof value.session.state.prebuiltResolutions>[number]) => {
    value.session.state.prebuiltResolutions = [proof]; await value.session.persist();
  });
  const guard = () => assertManagedRemoteSettled(paths, value.session.execution, undefined,
    { ...value.transport, buildInfo: readOldMarker }, resolveOldEffect);
  return { value, candidate, paths, published, originPath, original, receiptPath, receipt, verification, readOldMarker, resolveOldEffect, guard };
}

it('uses a sealed successful legacy verification instead of reacquiring old candidate access', async () => {
  const proof = await archivePromotionVerification('complete');
  await expect(proof.guard()).resolves.toBeUndefined();
  await expect(proof.guard()).resolves.toBeUndefined();
  expect(proof.readOldMarker).not.toHaveBeenCalled();
  expect(proof.resolveOldEffect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ runId: proof.published.report.runId,
    sourceSha: proof.candidate.sourceSha, configSha256: proof.candidate.configSha256,
    artifactSha256: proof.candidate.artifactSha256, deploymentId: proof.candidate.deploymentId, promotion: 'succeeded' }));
  expect(await readFile(proof.originPath)).toEqual(proof.original);
  expect(await readFile(proof.receiptPath)).toEqual(proof.receipt);
  if (!proof.verification) throw new Error('missing verification archive');
  expect(await readFile(proof.verification.path)).toEqual(proof.verification.bytes);
  expect(proof.value.engine.counts()).toEqual({ creates: 1, promotions: 1 });
});

it.each(['missing', 'failed', 'incomplete', 'incomplete-completion', 'other-completion-run', 'wrong-source', 'wrong-artifact', 'wrong-candidate', 'unbound', 'replaced-receipt'] as const)(
  'retains the ordinary guard when archived promotion verification is %s', async mode => {
    const proof = await archivePromotionVerification(mode);
    await expect(proof.guard()).rejects.toMatchObject({ code: 'VERCEL_API', details: { reason: 'REQUEST_TIMEOUT' } });
    expect(proof.readOldMarker).toHaveBeenCalledOnce();
    expect(proof.resolveOldEffect).not.toHaveBeenCalled();
  });
