import { boundary, fixture, runRelease } from './helpers/completion-publication-fixture.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { completionDeadline } from './helpers/completion-deadline.js';
import { hasVerifiedManagedClosure, hasVerifiedManagedStop } from '../src/node/managed-closure.js';

it.each(['timeout', 'cancel'] as const)('preserves promoted effects and native stop proof when completion ends by %s', async kind => {
  const controller = new AbortController();
  const deadline = kind === 'timeout' ? completionDeadline(1000) : undefined;
  boundary.deadline = deadline;
  const value = await fixture({ mode: 'wait', ...(kind === 'timeout' ? { jobTimeoutMs: 1000 } : {}) });
  const pending = runRelease({ command: 'publish', cwd: value.cwd, signal: controller.signal, transport: value.transport });
  try {
    try {
      await expect.poll(async () => (await value.results()).length, { timeout: 120_000, interval: 100 }).toBe(1);
    } catch (error) {
      controller.abort();
      const report = await pending;
      throw new AggregateError([error, new Error(JSON.stringify({ stage: report.stage, error: report.error }))],
        'completion observation failed', { cause: error });
    }
    if (deadline) {
      deadline.advance(999);
      expect(JSON.parse(await readFile(resolve(value.cwd, '.tmp/release-slot/state.json'), 'utf8')))
        .toMatchObject({ completion: { status: 'running' } });
      deadline.advance(1);
    }
    if (kind === 'cancel') controller.abort();
    const report = await pending;
    expect(report, JSON.stringify(report.error)).toMatchObject({ ok: false,
      error: { code: kind === 'timeout' ? 'COMMAND_TIMEOUT' : 'CANCELLED' },
      prebuilt: { createEffect: 'accepted', promoteEffect: 'accepted', promotionVerified: true },
      completion: { status: 'failed', attempts: [{ status: 'failed', jobs: [{ status: 'failed' }] }] },
      processes: { status: 'closed' } });
    const state = JSON.parse(await readFile(resolve(value.cwd, '.tmp/release-slot/state.json'), 'utf8'));
    const command = state.processes.find((item: { name: string }) => item.name === 'completion:0');
    expect(command).toMatchObject({ status: 'stopped',
      closure: { ownedScope: { status: 'unknown', reason: 'terminated', empty: true }, requestedTermination: kind === 'timeout' ? 'timeout' : 'abort' } });
    expect(hasVerifiedManagedStop(command)).toBe(true);
    expect(hasVerifiedManagedClosure(command)).toBe(false);
    expect(await value.results()).toHaveLength(1);
    expect(await value.counts()).toEqual({ creates: 1, promotions: 1, assignments: 1 });
  } finally { controller.abort(); }
}, 180_000);

it('fails closed when the real deadline expires before completion identity becomes available', async () => {
  boundary.blockCompletionIdentity = true;
  const value = await fixture({ mode: 'wait', jobTimeoutMs: 1000 });
  const report = await runRelease({ command: 'publish', cwd: value.cwd, transport: value.transport });
  expect(report, JSON.stringify(report.error)).toMatchObject({ ok: false, error: { code: 'PROCESS_STATE_UNKNOWN' },
    prebuilt: { createEffect: 'accepted', promoteEffect: 'accepted', promotionVerified: true },
    completion: { status: 'unknown', attempts: [{ status: 'unknown', jobs: [{ status: 'unknown' }] }] },
    processes: { status: 'unknown' } });
  const state = JSON.parse(await readFile(resolve(value.cwd, '.tmp/release-slot/state.json'), 'utf8'));
  const command = state.processes.find((item: { name: string }) => item.name === 'completion:0');
  expect(command).toMatchObject({ status: 'unknown', closure: { requestedTermination: 'timeout',
    ownedScope: { status: 'unknown', reason: 'terminated', empty: true } } });
  expect(hasVerifiedManagedStop(command)).toBe(false); expect(hasVerifiedManagedClosure(command)).toBe(false);
  expect(await value.results()).toHaveLength(0);
  expect(await value.counts()).toEqual({ creates: 1, promotions: 1, assignments: 1 });
}, 180_000);
