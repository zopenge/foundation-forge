import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { publishCandidate } from '../src/node/publication.js';
import { configDigest } from '../src/node/source.js';
import { prebuiltFixture } from './helpers/prebuilt-fixture.js';
import { prebuiltConfiguration } from './helpers/prebuilt-configuration.js';
import { ensureTestTemporaryDirectory } from '../../../scripts/test-temporary-directory.mjs';

const owned: Awaited<ReturnType<typeof prebuiltFixture>>[] = [];
afterEach(async () => { for (const value of owned.splice(0)) await value.dispose(); });

it('binds a real phase artifact to the supplied frozen source and configuration', async () => {
  const sha = 'e'.repeat(40), config = { ...prebuiltConfiguration(), checks: [{ command: 'node', args: ['supplied-check.mjs'] }] };
  const value = await prebuiltFixture({ sha, config }); owned.push(value);
  const result = await publishCandidate(value.context, 'publish');
  expect(result).toMatchObject({ sha, id: 'dpl_candidate' });
  expect(value.prebuilt.state).toMatchObject({ sourceSha: sha, configSha256: await configDigest(config), promotionVerified: true });
  const marker = JSON.parse(await readFile(resolve(value.uploadRoot, '.vercel/output/static/.well-known/forge-prebuilt.json'), 'utf8'));
  expect(marker).toMatchObject({ sourceSha: sha, configSha256: await configDigest(config) });
  expect(value.counts()).toEqual({ creates: 1, promotions: 1 });
});

it('rejects undeclared application commands before they can escape the phase boundary', async () => {
  const value = await prebuiltFixture(); owned.push(value);
  await expect(value.context.execution.run('unexpected', { command: 'node', args: ['unexpected.mjs'] }, 'CHECK_FAILED'))
    .rejects.toThrow('unexpected phase command');
});

it('rejects every Git stream before starting a real subprocess', async () => {
  const value = await prebuiltFixture(); owned.push(value);
  await expect(value.context.execution.streamGit(['rev-parse', 'HEAD'], () => {})).rejects.toThrow('must not execute Git');
});

it('uses a caller-owned checkout without deleting its unrelated input on disposal', async () => {
  const repository = resolve(import.meta.dirname, '../../..');
  const base = await ensureTestTemporaryDirectory(repository, resolve(repository, 'tmp/prebuilt-phase-input'));
  const root = await mkdtemp(resolve(base, 'r-'));
  try {
    await writeFile(resolve(root, 'caller.txt'), 'preserve');
    const value = await prebuiltFixture({ root });
    try {
      expect(value.root).toBe(root);
      await publishCandidate(value.context, 'publish');
    } finally { await value.dispose(); }
    expect(await readFile(resolve(root, 'caller.txt'), 'utf8')).toBe('preserve');
  } finally { await rm(root, { recursive: true, force: true }); }
});
