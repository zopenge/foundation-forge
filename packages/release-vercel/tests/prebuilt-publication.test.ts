import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { publishCandidate } from '../src/node/publication.js';
import { ReleaseError } from '../src/node/errors.js';
import { prebuiltFixture } from './helpers/prebuilt-fixture.js';

const owned: Awaited<ReturnType<typeof prebuiltFixture>>[] = [];
afterEach(async () => { for (const item of owned.splice(0)) await item.dispose(); });
async function fixture() { const value = await prebuiltFixture(); owned.push(value); return value; }

describe('prebuilt publication through the existing release engine', () => {
  it('stages an unlinked production candidate, accepts that ID, then promotes and verifies its alias', async () => {
    const value = await fixture();
    value.hooks.run = (name, values) => {
      if (name.startsWith('acceptance:')) expect(values).toMatchObject({ FORGE_RELEASE_SHA: value.sha,
        FORGE_RELEASE_URL: 'https://candidate.vercel.app', FORGE_RELEASE_DEPLOYMENT_ID: 'dpl_candidate' });
    };
    const result = await publishCandidate(value.context, 'publish');
    expect(result).toMatchObject({ id: 'dpl_candidate', sha: value.sha, state: 'READY', projectId: 'prj_fixture' });
    expect(value.counts()).toEqual({ creates: 1, promotions: 1 });
    const order = value.trace.filter(item => ['run:check:0', 'run:admission:create:0', 'run:prebuilt-create',
      'run:acceptance:0', 'run:admission:promote:0', 'promote'].includes(item));
    expect(order).toEqual(['run:check:0', 'run:admission:create:0', 'run:prebuilt-create', 'run:acceptance:0', 'run:admission:promote:0', 'promote']);
    expect(value.effects).toEqual({ developmentPush: 'not-attempted', releasePush: 'not-attempted', deploymentCreate: 'accepted', deploymentPromote: 'accepted' });
    expect(value.context.prebuilt?.state?.promotionVerified).toBe(true);
    expect(value.snapshots.some(item => item.createEffect === 'unknown' && !item.deploymentId)).toBe(true);
    expect(value.snapshots.some(item => item.promoteEffect === 'unknown' && item.deploymentId === 'dpl_candidate')).toBe(true);
  });
  it('checks and freezes only self-contained Build Output without making any cloud request', async () => {
    const value = await fixture();
    await writeFile(resolve(value.root, 'source-secret.txt'), 'not part of the artifact');
    await expect(publishCandidate(value.context, 'check')).resolves.toBeUndefined();
    expect(value.counts()).toEqual({ creates: 0, promotions: 0 });
    expect(value.trace.some(item => item.startsWith('api:'))).toBe(false);
    expect((await readdir(value.uploadRoot)).sort()).toEqual(['.vercel']);
    const uploaded = await readFile(resolve(value.uploadRoot, '.vercel/output/static/index.html'));
    expect(uploaded.toString()).toBe('<h1>candidate</h1>');
    const manifest = JSON.parse(await readFile(resolve(value.uploadRoot, '.vercel/forge-artifact.json'), 'utf8'));
    expect(manifest.files.find((item: { path: string }) => item.path === 'static/index.html').sha256)
      .toBe(createHash('sha256').update('<h1>candidate</h1>').digest('hex'));
  });
  it.each(['secret', 'too-many', 'too-large', 'missing-config', 'wrong-version', 'reserved-marker', 'external-link'])('rejects unsafe artifacts before cloud writes: %s', async kind => {
    const value = await fixture();
    if (kind === 'secret') await writeFile(resolve(value.output, '.env.production'), 'TOKEN=private');
    if (kind === 'too-many') value.config.delivery = { ...value.config.delivery, maxFiles: 1 };
    if (kind === 'too-large') value.config.delivery = { ...value.config.delivery, maxBytes: 1 };
    if (kind === 'missing-config') await unlink(resolve(value.output, 'config.json'));
    if (kind === 'wrong-version') await writeFile(resolve(value.output, 'config.json'), '{"version":2}');
    if (kind === 'reserved-marker') {
      await mkdir(resolve(value.output, 'static/.well-known'), { recursive: true });
      await writeFile(resolve(value.output, 'static/.well-known/forge-prebuilt.json'), '{}');
    }
    if (kind === 'external-link') await symlink(value.root, resolve(value.output, 'outside'), 'junction');
    await expect(publishCandidate(value.context, 'publish')).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' });
    expect(value.counts()).toEqual({ creates: 0, promotions: 0 });
  });
  it.each(['owner', 'project', 'target', 'source', 'id'])('rejects authoritative candidate mismatches instead of trusting commit meta: %s', async kind => {
    const value = await fixture();
    value.hooks.api = (path, response) => path.startsWith('/v13/') ? { ...response,
      ...(kind === 'owner' ? { ownerId: 'team_other' } : {}), ...(kind === 'project' ? { projectId: 'prj_other' } : {}),
      ...(kind === 'target' ? { target: 'preview' } : {}), ...(kind === 'source' ? { source: 'git' } : {}),
      ...(kind === 'id' ? { id: 'dpl_other' } : {}), meta: { githubCommitSha: value.sha } } : response;
    await expect(publishCandidate(value.context, 'publish')).rejects.toMatchObject({ code: 'DEPLOYMENT_SOURCE' });
    expect(value.counts().promotions).toBe(0);
  });
  it('does not promote when actual acceptance fails', async () => {
    const value = await fixture(); value.hooks.run = name => { if (name === 'acceptance:0') throw new ReleaseError('ACCEPTANCE_FAILED'); };
    await expect(publishCandidate(value.context, 'publish')).rejects.toMatchObject({ code: 'ACCEPTANCE_FAILED' });
    expect(value.counts()).toEqual({ creates: 1, promotions: 0 });
  });
  it.each(['create', 'promote'])('enforces consumer cost admission before %s', async phase => {
    const value = await fixture(); value.hooks.run = name => { if (name === `admission:${phase}:0`) throw new ReleaseError('ADMISSION_FAILED'); };
    await expect(publishCandidate(value.context, 'publish')).rejects.toMatchObject({ code: 'ADMISSION_FAILED' });
    expect(value.counts()).toEqual({ creates: phase === 'create' ? 0 : 1, promotions: 0 });
  });
  it('refuses changed build output after acceptance', async () => {
    const value = await fixture(); value.hooks.run = async name => {
      if (name === 'acceptance:0') await writeFile(resolve(value.output, 'static/index.html'), 'changed after acceptance');
    };
    await expect(publishCandidate(value.context, 'publish')).rejects.toMatchObject({ code: 'ARTIFACT_CHANGED' });
    expect(value.counts().promotions).toBe(0);
  });
  it('refuses changes to the isolated upload copy before staging', async () => {
    const value = await fixture(); value.hooks.run = async name => {
      if (name === 'admission:create:0') await writeFile(resolve(value.uploadRoot, '.vercel/output/static/index.html'), 'changed upload copy');
    };
    await expect(publishCandidate(value.context, 'publish')).rejects.toMatchObject({ code: 'ARTIFACT_CHANGED' });
    expect(value.counts()).toEqual({ creates: 0, promotions: 0 });
  });
  it('compares marker fields independently of JSON property order', async () => {
    const value = await fixture(); value.hooks.marker = marker => Object.fromEntries(Object.entries(marker as Record<string, unknown>).reverse());
    await expect(publishCandidate(value.context, 'publish')).resolves.toMatchObject({ id: 'dpl_candidate' });
    expect(value.counts()).toEqual({ creates: 1, promotions: 1 });
  });
  it('admits the upload-copy growth before creating it', async () => {
    const value = await fixture();
    Object.assign(value.prebuilt, { reserve: async () => { throw new ReleaseError('BUDGET_EXCEEDED'); } });
    await expect(publishCandidate(value.context, 'publish')).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(value.counts()).toEqual({ creates: 0, promotions: 0 });
  });
  it('does not create when write-ahead persistence fails', async () => {
    const value = await fixture(); value.hooks.save = () => { throw new ReleaseError('IO_FAILED'); };
    await expect(publishCandidate(value.context, 'publish')).rejects.toMatchObject({ code: 'IO_FAILED' });
    expect(value.counts()).toEqual({ creates: 0, promotions: 0 });
  });
  it('does not repeat an unknown create operation', async () => {
    const value = await fixture(); let attempts = 0;
    value.hooks.run = name => { if (name === 'prebuilt-create') { attempts++; throw new ReleaseError('COMMAND_TIMEOUT'); } };
    await expect(publishCandidate(value.context, 'publish')).rejects.toMatchObject({ code: 'COMMAND_TIMEOUT' });
    await expect(publishCandidate(value.context, 'publish')).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(attempts).toBe(1); expect(value.context.prebuilt?.state?.createEffect).toBe('unknown');
  });
  it('does not repeat an unknown promotion', async () => {
    const value = await fixture(); value.hooks.promote = () => { throw new ReleaseError('VERCEL_API'); };
    await expect(publishCandidate(value.context, 'publish')).rejects.toMatchObject({ code: 'VERCEL_API' });
    await expect(publishCandidate(value.context, 'publish')).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(value.counts()).toEqual({ creates: 1, promotions: 1 });
  });
  it.each(['timeout', 'cancel'])('bounds a custom promotion transport and preserves its unknown intent on %s', async kind => {
    const value = await fixture();
    let stopped = false;
    value.hooks.promote = signal => new Promise<void>((_resolve, reject) => {
      const fallback = setTimeout(() => reject(new Error('request budget was not propagated')), 800);
      signal.addEventListener('abort', () => { clearTimeout(fallback); stopped = true; reject(new ReleaseError('CANCELLED')); }, { once: true });
      if (kind === 'cancel') value.controller.abort();
    });
    await expect(publishCandidate(value.context, 'publish')).rejects.toMatchObject({ code: kind === 'cancel' ? 'CANCELLED' : 'VERCEL_API' });
    expect(stopped).toBe(true);
    expect(value.prebuilt.state?.promoteEffect).toBe('unknown');
    expect(value.prebuilt.state?.promotionVerified).toBe(false);
    if (kind === 'timeout') await expect(publishCandidate(value.context, 'publish')).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(value.counts()).toEqual({ creates: 1, promotions: 1 });
  });
  it('reuses the exact accepted candidate on an explicit repeat instead of rebuilding it', async () => {
    const value = await fixture(); await publishCandidate(value.context, 'publish'); await publishCandidate(value.context, 'publish');
    expect(value.counts()).toEqual({ creates: 1, promotions: 1 });
  });
  it('rejects a marker whose content digest differs from the frozen artifact', async () => {
    const value = await fixture(); value.hooks.marker = marker => ({ ...marker as object, artifactSha256: 'b'.repeat(64) });
    await expect(publishCandidate(value.context, 'publish')).rejects.toMatchObject({ code: 'ARTIFACT_CHANGED' });
    expect(value.counts().promotions).toBe(0);
  });
  it('honors cancellation before any cloud write', async () => {
    const value = await fixture(); value.controller.abort();
    await expect(publishCandidate(value.context, 'publish')).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(value.counts()).toEqual({ creates: 0, promotions: 0 });
  });
  it.each([
    { status: 'pending', id: 'dpl_candidate', code: 'ALIAS_MISMATCH' },
    { status: 'failed', id: 'dpl_candidate', code: 'DEPLOYMENT_FAILED' },
    { status: 'succeeded', id: 'dpl_other', code: 'ALIAS_MISMATCH' },
  ])('does not declare completion from an alias while the authoritative promotion job is $status for $id', async entry => {
    const value = await fixture(); value.hooks.api = (path, response) => path.startsWith('/v9/projects/') && value.counts().promotions > 0
      ? { ...response, lastAliasRequest: { type: 'promote', jobStatus: entry.status, toDeploymentId: entry.id } } : response;
    await expect(publishCandidate(value.context, 'publish')).rejects.toMatchObject({ code: entry.code });
    expect(value.counts()).toEqual({ creates: 1, promotions: 1 });
    expect(value.prebuilt.state?.promotionVerified).toBe(false);
  });
  it('refuses rolling-release targets before creating a production candidate', async () => {
    const value = await fixture(); value.hooks.api = (path, response) => path.startsWith('/v9/projects/') ? { ...response, rollingRelease: { enabled: true } } : response;
    await expect(publishCandidate(value.context, 'publish')).rejects.toMatchObject({ code: 'SOURCE_UNSUPPORTED' });
    expect(value.counts()).toEqual({ creates: 0, promotions: 0 });
  });
  it('rejects incompatible project root directories before recording an unknown create', async () => {
    const value = await fixture(); value.hooks.api = (path, response) => path.startsWith('/v9/projects/') ? { ...response, rootDirectory: 'apps/web' } : response;
    await expect(publishCandidate(value.context, 'publish')).rejects.toMatchObject({ code: 'SOURCE_UNSUPPORTED', details: { reason: 'PREBUILT_PROJECT_ROOT' } });
    expect(value.prebuilt.state?.createEffect).toBe('not-attempted');
    expect(value.counts()).toEqual({ creates: 0, promotions: 0 });
    delete value.hooks.api;
    await expect(publishCandidate(value.context, 'publish')).resolves.toMatchObject({ id: 'dpl_candidate' });
  });
  it.runIf(process.platform !== 'win32')('preserves POSIX artifact modes even when the caller umask removes group write permission', async () => {
    const value = await fixture(), original = process.umask(0o022);
    try {
      await chmod(resolve(value.output, 'static/index.html'), 0o664);
      await expect(publishCandidate(value.context, 'publish')).resolves.toMatchObject({ id: 'dpl_candidate' });
      expect((await stat(resolve(value.uploadRoot, '.vercel/output/static/index.html'))).mode & 0o777).toBe(0o664);
    } finally { process.umask(original); }
  });
});
