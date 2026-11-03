import { mkdir, readFile, readlink, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { realpath as nativeRealpath } from 'node:fs/promises';
import { realpath as realpathForNode } from 'node:fs';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { assertPrebuiltArtifact, freezePrebuiltArtifact } from '../src/node/prebuilt-artifact.js';
import { prebuiltFixture } from './helpers/prebuilt-fixture.js';
import { linkedFunction, putArtifactFile as put } from './helpers/prebuilt-linked-output.js';
import { fixtureExec as execute } from './helpers/fixture-exec.js';
import * as managedIo from '../src/node/managed-io.js';

const owned: Awaited<ReturnType<typeof prebuiltFixture>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const item of owned.splice(0)) await item.dispose(); });
async function fixture() { const value = await prebuiltFixture(); owned.push(value); return value; }
async function load(path: string, signal: AbortSignal): Promise<string> {
  const result = await execute(process.execPath, ['-e', 'process.stdout.write(require(process.argv[1]))', path],
    { signal, timeout: 5000, windowsHide: true, encoding: 'utf8' });
  return result.stdout;
}

it('preserves two-level pnpm resolution and function aliases after moving the sealed copy and removing original output', async context => {
  const f = await fixture(); await linkedFunction(f.output);
  expect(await load(resolve(f.output, 'functions/alias.func/index.cjs'), context.signal)).toBe('closed-layout');
  const artifact = await freezePrebuiltArtifact(f.root, f.config, f.sha, context.signal, async () => {});
  const moved = resolve(f.root, 'moved'); await rename(artifact.uploadRoot, moved);
  await rm(f.output, { recursive: true, force: true });
  const output = resolve(moved, '.vercel/output');
  expect((await readlink(resolve(output, 'functions/alias.func'))).replaceAll('\\', '/')).toBe('main.func');
  expect((await readlink(resolve(output, 'functions/main.func/node_modules/a'))).replaceAll('\\', '/')).toBe('.pnpm/a@1.0.0/node_modules/a');
  expect(await load(resolve(output, 'functions/alias.func/index.cjs'), context.signal)).toBe('closed-layout');
  const manifest = JSON.parse(await readFile(resolve(moved, '.vercel/forge-artifact.json'), 'utf8'));
  expect(manifest.links).toHaveLength(4);
});

it('binds the relative link target even when both complete targets contain identical bytes', async context => {
  const digests: string[] = [];
  for (const target of ['a.func', 'b.func']) {
    const f = await fixture();
    for (const name of ['a.func', 'b.func']) await put(resolve(f.output, `functions/${name}/index.cjs`), 'module.exports="same"');
    await symlink(target, resolve(f.output, 'functions/alias.func'), 'dir');
    digests.push((await freezePrebuiltArtifact(f.root, f.config, f.sha, context.signal, async () => {})).artifactSha256);
  }
  expect(digests[0]).not.toBe(digests[1]);
});

it.for(['absolute', 'outside', 'dangling', 'link-cycle', 'directory-cycle', 'case-mismatch', 'drive-relative'] as const)('rejects %s without creating a candidate', async (kind, context) => {
  const f = await fixture(), link = resolve(f.output, 'alias');
  if (kind === 'directory-cycle') {
    await mkdir(resolve(f.output, 'a')); await mkdir(resolve(f.output, 'b'));
    await symlink('../b', resolve(f.output, 'a/link'), 'dir'); await symlink('../a', resolve(f.output, 'b/link'), 'dir');
  } else if (kind === 'link-cycle') {
    await symlink('other', link, 'dir'); await symlink('alias', resolve(f.output, 'other'), 'dir');
  } else {
    const target = kind === 'absolute' ? resolve(f.output, 'static') : kind === 'outside' ? '../outside'
      : kind === 'case-mismatch' ? 'Static' : kind === 'drive-relative' ? 'C:outside' : 'missing';
    if (kind === 'outside') await put(resolve(f.root, '.vercel/outside/value'), 'outside');
    await symlink(target, link, 'dir');
  }
  await expect(freezePrebuiltArtifact(f.root, f.config, f.sha, context.signal, async () => {})).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' });
  expect(f.counts()).toEqual({ creates: 0, promotions: 0 });
});

it('checks native resolution against portable symlink-prefix and parent traversal semantics', async context => {
  const f = await fixture(); await mkdir(resolve(f.output, 'shared/deep'), { recursive: true });
  await put(resolve(f.output, 'shared/deep/keep'), '');
  await put(resolve(f.output, 'shared/leaf.cjs'), 'module.exports="portable"');
  await put(resolve(f.output, 'leaf.cjs'), 'module.exports="lexical"');
  await symlink('shared/deep', resolve(f.output, 'prefix'), 'dir');
  await symlink('prefix/../leaf.cjs', resolve(f.output, 'use.cjs'), 'file');
  const actual = await load(resolve(f.output, 'use.cjs'), context.signal);
  const [physicalTarget, runtimeTarget] = await Promise.all([nativeRealpath(resolve(f.output, 'use.cjs')), promisify(realpathForNode)(resolve(f.output, 'use.cjs'))]);
  expect(['portable', 'lexical']).toContain(actual);
  expect(runtimeTarget).toBe(resolve(f.output, actual === 'portable' ? 'shared/leaf.cjs' : 'leaf.cjs'));
  const seal = () => freezePrebuiltArtifact(f.root, f.config, f.sha, context.signal, async () => {});
  if (actual !== 'portable') await expect(seal(), JSON.stringify({ actual, physicalTarget, runtimeTarget })).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' });
  else {
    const artifact = await seal();
    expect(await load(resolve(artifact.uploadRoot, '.vercel/output/use.cjs'), context.signal)).toBe('portable');
  }
});

it.for([false, true])('rejects an empty payload directory that the official archive cannot materialize, alias=%s', async (alias, context) => {
  const f = await fixture(); await mkdir(resolve(f.output, 'empty'));
  if (alias) await symlink('empty', resolve(f.output, 'alias'), 'dir');
  await expect(freezePrebuiltArtifact(f.root, f.config, f.sha, context.signal, async () => {}))
    .rejects.toMatchObject({ code: 'ARTIFACT_INVALID', details: { reason: 'EMPTY_DIRECTORY' } });
});

it('materializes the reserved marker parents even when the producer leaves them empty', async context => {
  const f = await fixture(); await mkdir(resolve(f.output, 'static/.well-known'));
  await symlink('static/.well-known', resolve(f.output, 'marker-alias'), 'dir');
  const artifact = await freezePrebuiltArtifact(f.root, f.config, f.sha, context.signal, async () => {});
  const marker = JSON.parse(await readFile(resolve(artifact.uploadRoot, '.vercel/output/marker-alias/forge-prebuilt.json'), 'utf8'));
  expect(marker.artifactSha256).toBe(artifact.artifactSha256);
});

it.for(['source-link', 'copied-link', 'manifest'] as const)('refuses sealed %s mutation even without a payload byte change', async (kind, context) => {
  const f = await fixture(); await linkedFunction(f.output);
  const artifact = await freezePrebuiltArtifact(f.root, f.config, f.sha, context.signal, async () => {});
  if (kind === 'manifest') {
    const path = resolve(artifact.uploadRoot, '.vercel/forge-artifact.json');
    const manifest = JSON.parse(await readFile(path, 'utf8')); manifest.links[0].target = 'changed'; await writeFile(path, JSON.stringify(manifest));
  } else {
    const output = kind === 'source-link' ? f.output : resolve(artifact.uploadRoot, '.vercel/output');
    const path = resolve(output, 'functions/alias.func'); await unlink(path); await symlink('./main.func', path, 'dir');
  }
  await expect(assertPrebuiltArtifact(artifact, f.config, context.signal)).rejects.toMatchObject({ code: 'ARTIFACT_CHANGED' });
});

it.for(['files', 'bytes'] as const)('charges links to the existing %s budget', async (kind, context) => {
  const f = await fixture(); await linkedFunction(f.output);
  const full = await freezePrebuiltArtifact(f.root, f.config, f.sha, context.signal, async () => {});
  const config = { ...f.config, delivery: { ...f.config.delivery, ...(kind === 'files'
    ? { maxFiles: full.files.length } : { maxBytes: full.files.reduce((bytes, file) => bytes + file.byteLength, 0) }) } };
  await expect(freezePrebuiltArtifact(f.root, config, f.sha, context.signal, async () => {})).rejects.toMatchObject({ code: 'ARTIFACT_INVALID' });
});

it('preserves a relative file link and rejects source changes between the snapshot and copy', async context => {
  const f = await fixture(); await linkedFunction(f.output);
  await symlink('functions/main.func/index.cjs', resolve(f.output, 'entry.cjs'), 'file');
  const artifact = await freezePrebuiltArtifact(f.root, f.config, f.sha, context.signal, async () => {});
  expect(artifact.links.find(link => link.path === 'entry.cjs')).toMatchObject({ kind: 'file', resolvedPath: 'functions/main.func/index.cjs' });
  expect(await load(resolve(artifact.uploadRoot, '.vercel/output/entry.cjs'), context.signal)).toBe('closed-layout');
  await expect(freezePrebuiltArtifact(f.root, f.config, f.sha, context.signal, async () => {
    await unlink(resolve(f.output, 'entry.cjs')); await symlink('./functions/main.func/index.cjs', resolve(f.output, 'entry.cjs'), 'file');
  })).rejects.toMatchObject({ code: 'ARTIFACT_CHANGED' });
});

it.for(['cancel', 'deadline'] as const)('stops %s after reservation and never returns a late sealed artifact', async (kind, context) => {
  const f = await fixture(); await linkedFunction(f.output); const controller = new AbortController();
  const artifact = await freezePrebuiltArtifact(f.root, f.config, f.sha, context.signal, async () => {});
  const owner = resolve(artifact.uploadRoot, '.vercel/forge-artifact.json'), before = await readFile(owner);
  const signal = AbortSignal.any([context.signal, controller.signal]); let elapsed = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => elapsed);
  await expect(freezePrebuiltArtifact(f.root, f.config, f.sha, signal, async () => {
    if (kind === 'cancel') controller.abort(); else elapsed = f.config.limits.commandMs + 1;
  })).rejects.toMatchObject({ code: kind === 'cancel' ? 'CANCELLED' : 'BUDGET_EXCEEDED' });
  expect(await readFile(owner)).toEqual(before);
});

it.for(['cancel', 'deadline'] as const)('rejects %s during the final real metadata read instead of returning a late success', async (kind, context) => {
  const f = await fixture(); await linkedFunction(f.output);
  const artifact = await freezePrebuiltArtifact(f.root, f.config, f.sha, context.signal, async () => {});
  const controller = new AbortController(), signal = AbortSignal.any([context.signal, controller.signal]); let elapsed = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => elapsed);
  const read = managedIo.readBoundedJson;
  vi.spyOn(managedIo, 'readBoundedJson').mockImplementation(async (path, limit) => {
    const value = await read(path, limit);
    if (path.endsWith('forge-prebuilt.json')) {
      if (kind === 'cancel') controller.abort(); else elapsed = f.config.limits.commandMs + 1;
    }
    return value;
  });
  await expect(assertPrebuiltArtifact(artifact, f.config, signal)).rejects.toMatchObject({ code: kind === 'cancel' ? 'CANCELLED' : 'BUDGET_EXCEEDED' });
});
