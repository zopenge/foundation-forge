import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { publishCandidate } from '../src/node/publication.js';
import { prebuiltFixture } from './helpers/prebuilt-fixture.js';

const fixtures: Awaited<ReturnType<typeof prebuiltFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.dispose(); });

it('gives the build its exact version URL and config identity before creating any candidate', async () => {
  const fixture = await prebuiltFixture(); fixtures.push(fixture);
  Object.assign(fixture.config.delivery, { versionAlias: { hostnameTemplate: 'fixture-{sha}.vercel.app' } });
  const values: Readonly<Record<string, string>>[] = [];
  fixture.hooks.run = (name, environment) => { if (name === 'check:0') values.push(environment ?? {}); };
  await publishCandidate(fixture.context, 'check');
  expect(values).toHaveLength(1);
  expect(values[0]).toMatchObject({ FORGE_RELEASE_SHA: 'a'.repeat(40),
    FORGE_RELEASE_VERSION_URL: `https://fixture-${'a'.repeat(40)}.vercel.app`,
    FORGE_RELEASE_CONFIG_SHA256: createHash('sha256').update(JSON.stringify(fixture.config)).digest('hex'),
    FORGE_RELEASE_CANDIDATE_CONTEXT: '' });
  expect(fixture.counts()).toEqual({ creates: 0, promotions: 0 });
});

it('rejects a version hostname equal to the stable production hostname before build or cloud operations', async () => {
  const fixture = await prebuiltFixture(); fixtures.push(fixture);
  Object.assign(fixture.config.delivery, { versionAlias: { hostnameTemplate: 'fixture-{sha}.vercel.app' } });
  Object.assign(fixture.config.vercel, { productionUrl: `https://fixture-${'a'.repeat(40)}.vercel.app` });
  await expect(publishCandidate(fixture.context, 'check')).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  expect(fixture.trace).toEqual([]);
});
