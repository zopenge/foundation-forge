import { afterEach, expect, it } from 'vitest';
import { prebuiltPhaseFixture } from './helpers/prebuilt-phase-fixture.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const owned: Awaited<ReturnType<typeof prebuiltPhaseFixture>>[] = [];
afterEach(async () => { for (const value of owned.splice(0)) await value.dispose(); });

it('persists publication phase transitions without inventing native process witnesses', async () => {
  const value = await prebuiltPhaseFixture(); owned.push(value);
  await value.publish();
  const state = await value.session.slot.store.read();
  expect(state?.prebuilt).toMatchObject({ deploymentId: 'dpl_candidate', sourceSha: value.sha, promotionVerified: true });
  expect(state?.processes).toEqual([]);
  expect(value.engine.counts()).toEqual({ creates: 1, promotions: 1 });
});

it('archives the original phase and binds a fresh session to its real archive identity', async () => {
  const value = await prebuiltPhaseFixture(); owned.push(value);
  await value.publish();
  const original = value.session.state.runId;
  await value.archive(true);
  const path = resolve(value.session.slot.paths.slotRoot, 'history', `${original}.json`), before = await readFile(path);
  await value.next('verify');
  expect(value.session.state.runId).not.toBe(original);
  expect(value.session.state.history).toEqual([expect.objectContaining({ path: `history/${original}.json`,
    file: expect.objectContaining({ identity: expect.any(Object), sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }) })]);
  expect(await readFile(path)).toEqual(before);
  expect(value.session.state.processes).toEqual([]);
});

it('seals the real checkout and artifact input at the production completion intent', async () => {
  const value = await prebuiltPhaseFixture({ completion: { idempotent: true,
    jobs: [{ command: 'node', args: ['-e', 'process.exit(0)'] }] } }); owned.push(value);
  await value.publish();
  const state = await value.session.slot.store.read();
  expect(value.engine.root).toBe(value.session.execution.cwd);
  expect(state?.completion).toMatchObject({ status: 'not-started', publicationRunId: value.session.state.runId });
  expect(state?.completionInput).toMatchObject({ checkout: expect.any(Object), git: expect.any(Object),
    manifest: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) } });
  expect(state?.processes).toEqual([]);
});
