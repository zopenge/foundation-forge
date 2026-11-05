import { afterEach, expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { completionPhaseFixture } from './helpers/completion-phase-fixture.js';
import { admitCompletionSlot } from '../src/node/completion-history.js';
import * as recovery from '../src/node/managed-recovery.js';

vi.mock('../src/node/managed-recovery.js', async original => ({ ...await original<typeof recovery>() }));
const owned: Awaited<ReturnType<typeof completionPhaseFixture>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const value of owned.splice(0)) await value.dispose(); });

it('pins the sealed original SHA, requires explicit retry, and releases only a proved Native completion', async () => {
  const value = await completionPhaseFixture({ mode: 'fail' }); owned.push(value);
  const { paths, slotId, source } = value.session.slot;
  vi.spyOn(recovery, 'assertHistoricalSource').mockImplementation(async historical => { expect(historical).toEqual(source); });
  await expect(value.run()).rejects.toMatchObject({ code: 'COMPLETION_FAILED' });
  await value.session.assertClosed();
  const firstAttempt = structuredClone(value.session.state.completion?.attempts[0]);
  await value.archive(false);
  const receiptPath = resolve(paths.slotRoot, 'latest-publish.json'), receipt = await readFile(receiptPath);
  const input = structuredClone(value.session.state.completionInput);
  const changed = { ...source, sha: 'b'.repeat(40) };
  await expect(admitCompletionSlot(paths, slotId, changed, 'check')).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED',
    details: { reason: 'COMPLETION_PENDING', sourceSha: source.sha } });
  const resumed = await admitCompletionSlot(paths, slotId, source, 'verify');
  expect(resumed?.input).toEqual(input);
  await value.next('verify');
  if (!resumed) throw new Error('original completion must remain available');
  Object.assign(value.session.state, { prebuilt: resumed.prebuilt, completion: resumed.completion, completionInput: resumed.input,
    effects: { developmentPush: 'not-attempted', releasePush: 'not-attempted', deploymentCreate: 'accepted',
      deploymentPromote: 'accepted', versionAliasAssign: 'accepted' } });
  await value.session.persist();
  await expect(value.run()).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED', details: { reason: 'COMPLETION_RETRY_REQUIRED' } });
  expect(await value.results()).toHaveLength(1);
  expect(value.session.state.processes).toEqual([]);
  await writeFile(value.control, 'ok');
  await value.run(true); await value.session.assertClosed();
  const completion = structuredClone(value.session.state.completion);
  expect(completion).toMatchObject({ status: 'completed', attempts: [{ status: 'failed' }, { status: 'completed' }] });
  expect(completion?.attempts[0]).toEqual(firstAttempt);
  await value.archive(true);
  expect(await admitCompletionSlot(paths, slotId, changed, 'check')).toBeUndefined();
  await value.run(true);
  expect(value.session.state.completion).toEqual(completion);
  expect(await value.results()).toHaveLength(2);
  expect(await value.counts()).toEqual({ creates: 1, promotions: 1, assignments: 1 });
  expect(await readFile(receiptPath)).toEqual(receipt);
  expect(value.session.state.completionInput).toEqual(input);
}, 120_000);
