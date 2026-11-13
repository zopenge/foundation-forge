import { completionFixture, runs } from './helpers/prebuilt-publication-fixture.js';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('keeps a real Native failure in the public receipt and retries completion without repeating publication', async () => {
  const value = await completionFixture('fail');
  const failed = await runs.run({ command: 'publish', cwd: value.cwd, transport: value.transport });
  expect(failed, JSON.stringify(failed.error)).toMatchObject({ ok: false, error: { code: 'COMPLETION_FAILED' },
    processes: { status: 'closed' }, prebuilt: { createEffect: 'accepted', promoteEffect: 'accepted', promotionVerified: true },
    completion: { status: 'failed', attempts: [{ status: 'failed', jobs: [{ status: 'failed' }] }] } });
  const receiptPath = resolve(value.cwd, 'state/release-slot/latest-publish.json'), receipt = await readFile(receiptPath);
  const archive = JSON.parse(await readFile(resolve(value.cwd, `state/release-slot/history/${failed.runId}.json`), 'utf8'));
  expect(archive.outcome).toMatchObject({ ok: false, error: { code: 'COMPLETION_FAILED' } });
  expect(JSON.parse(archive.snapshot.publish).report.completion).toEqual(failed.completion);
  expect(archive.stopped.processes.find((item: { name: string }) => item.name === 'completion:0'))
    .toMatchObject({ status: 'closed', closure: { exitCode: 23, ownedScope: { status: 'closed', reason: 'normal', empty: true } } });
  await expect(readFile(value.session.slot.paths.lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  const status = await runs.run({ command: 'status', cwd: value.cwd, sha: value.sha, transport: value.transport });
  expect(status, JSON.stringify(status.error)).toMatchObject({ ok: false, completion: { status: 'failed' },
    processes: { status: 'closed' }, error: { code: 'RECOVERY_REQUIRED', details: { reason: 'COMPLETION_PENDING' } } });
  expect(await readFile(receiptPath)).toEqual(receipt);
  expect(await value.counts()).toEqual({ creates: 1, promotions: 1, assignments: 1 });
  expect(await value.results()).toHaveLength(1);
  await writeFile(value.control, 'ok');
  const resumed = await runs.run({ command: 'verify', cwd: value.cwd, sha: value.sha, retryCompletion: true, transport: value.transport });
  expect(resumed, JSON.stringify(resumed.error)).toMatchObject({ ok: true, candidateSha: value.sha,
    completion: { status: 'completed', publicationRunId: failed.runId } });
  expect(resumed.completion?.attempts).toHaveLength(2);
  expect(resumed.completion?.attempts[0]).toEqual(failed.completion?.attempts[0]);
  expect(resumed.completion?.attempts[1]).toMatchObject({ runId: resumed.runId, status: 'completed' });
  expect(await value.results()).toHaveLength(2);
  expect(await value.counts()).toEqual({ creates: 1, promotions: 1, assignments: 1 });
  expect(await readFile(receiptPath)).toEqual(receipt);
}, 120_000);
