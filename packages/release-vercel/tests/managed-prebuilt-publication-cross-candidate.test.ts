import { fixture } from './helpers/prebuilt-publication-fixture.js';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { runRelease } from '../src/node.js';
import { ReleaseError } from '../src/node/errors.js';
import * as source from '../src/node/source.js';
import * as remote from '../src/node/managed-remote-state.js';

vi.mock('../src/node/managed-remote-state.js', async original => ({ ...await original<typeof remote>() }));

it.each(['valid', 'missing', 'corrupt'] as const)('guards a new public candidate before cloud writes with %s archived alias proof', async kind => {
  const value = await fixture(true);
  value.hooks.alias = () => { throw new ReleaseError('VERCEL_API'); };
  const first = await runRelease({ command: 'publish', cwd: value.cwd, transport: value.transport });
  expect(first, JSON.stringify(first.error)).toMatchObject({ ok: false, error: { code: 'VERCEL_API' },
    prebuilt: { deploymentId: 'dpl_candidate', versionAlias: { effect: 'unknown', verified: false } } });
  const originalPath = resolve(value.cwd, `state/release-slot/history/${first.runId}.json`);
  const original = await readFile(originalPath);
  delete value.hooks.alias;
  let proofPath: string | undefined, proofBytes: Buffer | undefined;
  if (kind !== 'missing') {
    const verified = await runRelease({ command: 'verify', cwd: value.cwd, transport: value.transport });
    expect(verified, JSON.stringify(verified.error)).toMatchObject({ ok: true });
    proofPath = resolve(value.cwd, `state/release-slot/history/${verified.runId}.json`);
    proofBytes = await readFile(proofPath);
    expect(JSON.parse(proofBytes.toString('utf8')).stopped.prebuiltResolutions).toEqual([expect.objectContaining({
      runId: first.runId, sourceSha: value.sha, deploymentId: 'dpl_candidate',
      versionAlias: { hostname: `fixture-${value.sha}.vercel.app`, verified: true } })]);
    if (kind === 'corrupt') {
      const damaged = JSON.parse(proofBytes.toString('utf8'));
      damaged.stopped.prebuiltResolutions[0].deploymentId = 'dpl_unrelated';
      await writeFile(proofPath, JSON.stringify(damaged));
    }
  }
  const events: string[] = [], guard = remote.assertManagedRemoteSettled;
  vi.spyOn(remote, 'assertManagedRemoteSettled').mockImplementation(async (...args) => {
    events.push('guard:start'); const result = await guard(...args); events.push('guard:ok'); return result;
  });
  value.engine.hooks.run = name => { if (name === 'prebuilt-create') events.push('create'); };
  value.engine.hooks.api = (path, response) => {
    if (path.startsWith('/v13/deployments/dpl_candidate?')) throw new ReleaseError('VERCEL_API', { reason: 'OLD_CANDIDATE_UNAVAILABLE' });
    return response;
  };
  value.hooks.alias = () => { events.push('assign'); };
  value.hooks.promote = () => { events.push('promote'); };
  const nextSha = 'b'.repeat(40);
  vi.mocked(source.freezeManagedSource).mockResolvedValue({ ...value.source, sha: nextSha });
  const next = await runRelease({ command: 'publish', cwd: value.cwd, transport: value.transport });
  if (kind === 'valid') {
    expect(next, JSON.stringify(next.error)).toMatchObject({ ok: true, candidateSha: nextSha,
      prebuilt: { deploymentId: 'dpl_candidate2', promotionVerified: true, versionAlias: { verified: true } } });
    expect(events.filter(event => ['create', 'assign', 'promote'].includes(event))).toEqual(['create', 'assign', 'promote']);
    let previousWrite = -1;
    for (const write of ['create', 'assign', 'promote']) {
      const index = events.indexOf(write);
      expect(events.slice(previousWrite + 1, index)).toContain('guard:ok'); previousWrite = index;
    }
    if (!proofPath) throw new Error('archived verification proof required');
    expect(await readFile(proofPath)).toEqual(proofBytes);
    expect(value.engine.counts()).toEqual({ creates: 1, promotions: 1 });
  } else {
    expect(next, JSON.stringify(next.error)).toMatchObject({ ok: false, error: kind === 'missing'
      ? { code: 'VERCEL_API', details: { reason: 'OLD_CANDIDATE_UNAVAILABLE' } }
      : { code: 'SLOT_STATE', details: { reason: 'HISTORY_CHECKSUM' } } });
    expect(events.filter(event => ['create', 'assign', 'promote'].includes(event))).toEqual([]);
    expect(next.effects).toMatchObject({ developmentPush: 'not-attempted', releasePush: 'not-attempted' });
  }
  expect(await readFile(originalPath)).toEqual(original);
  expect(await value.transport.versionAlias?.read(`fixture-${value.sha}.vercel.app`, new AbortController().signal))
    .toMatchObject({ deploymentId: 'dpl_candidate' });
});
