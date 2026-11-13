import { afterEach, expect, it } from 'vitest';
import { prebuiltPhaseFixture } from './helpers/prebuilt-phase-fixture.js';
import { readFile } from 'node:fs/promises';

const owned: Awaited<ReturnType<typeof prebuiltPhaseFixture>>[] = [];
afterEach(async () => { for (const value of owned.splice(0)) await value.dispose(); });

it('checks and seals the same real artifact twice without creating or promoting a deployment', async () => {
  const value = await prebuiltPhaseFixture({ withAlias: true }); owned.push(value);
  value.transport.api = async () => { throw new Error('check must not query cloud API'); };
  value.transport.buildInfo = async () => { throw new Error('check must not read online build info'); };
  await value.publish('check');
  const first = structuredClone(value.session.state.prebuilt);
  expect(first).toMatchObject({ sourceSha: value.sha, fileCount: 2,
    createEffect: 'not-attempted', promoteEffect: 'not-attempted' });
  expect(first?.artifactSha256).toMatch(/^[a-f0-9]{64}$/u);
  await value.publish('check');
  expect(value.session.state.prebuilt?.artifactSha256).toBe(first?.artifactSha256);
  expect(value.engine.counts()).toEqual({ creates: 0, promotions: 0 });
  expect(value.assignments()).toBe(0);
  expect(value.session.state.processes).toEqual([]);
  const saved = JSON.parse(await readFile(value.session.slot.paths.statePath, 'utf8'));
  expect(saved.prebuilt).toEqual(value.session.state.prebuilt);
});
