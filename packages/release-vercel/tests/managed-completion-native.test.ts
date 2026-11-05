import { boundary } from './helpers/completion-publication-fixture.js';
import { completionPhaseFixture } from './helpers/completion-phase-fixture.js';
import { expect, it } from 'vitest';
import { completionDeadline } from './helpers/completion-deadline.js';
import { hasVerifiedManagedClosure, hasVerifiedManagedStop } from '../src/node/managed-closure.js';
import { waitForManagedReady } from './helpers/managed-readiness.js';

// 发布阶段提供真实封存输入；只执行completion，Native启动、身份、预算和关闭均不替换。
it.each(['timeout', 'cancel'] as const)('preserves promoted effects and native stop proof when completion ends by %s', async kind => {
  const controller = new AbortController();
  const deadline = kind === 'timeout' ? completionDeadline(1000) : undefined;
  boundary.deadline = deadline;
  const value = await completionPhaseFixture({ mode: 'wait', signal: controller.signal,
    ...(kind === 'timeout' ? { jobTimeoutMs: 1000 } : {}) });
  const running = value.run(), pending = running.then(() => undefined, (error: unknown) => error);
  try {
    try {
      await waitForManagedReady(running.then(() => value.report(true).report), async () => (await value.results()).length === 1);
    } catch (error) {
      controller.abort();
      throw new AggregateError([error, await pending], 'completion observation failed', { cause: error });
    }
    if (deadline) {
      deadline.advance(999);
      expect(await value.session.slot.store.read()).toMatchObject({ completion: { status: 'running' } });
      deadline.advance(1);
    }
    if (kind === 'cancel') controller.abort();
    expect(await pending).toMatchObject({ code: kind === 'timeout' ? 'COMMAND_TIMEOUT' : 'CANCELLED' });
    await value.session.assertStopped();
    const state = await value.session.slot.store.read();
    expect(state).toMatchObject({
      prebuilt: { createEffect: 'accepted', promoteEffect: 'accepted', promotionVerified: true },
      completion: { status: 'failed', attempts: [{ status: 'failed', jobs: [{ status: 'failed' }] }] } });
    const command = state?.processes.find(item => item.name === 'completion:0');
    expect(command).toMatchObject({ status: 'stopped',
      closure: { ownedScope: { status: 'unknown', reason: 'terminated', empty: true }, requestedTermination: kind === 'timeout' ? 'timeout' : 'abort' } });
    if (!command) throw new Error('real completion command required');
    expect(hasVerifiedManagedStop(command)).toBe(true);
    expect(hasVerifiedManagedClosure(command)).toBe(false);
    expect(await value.results()).toHaveLength(1);
    expect(await value.counts()).toEqual({ creates: 1, promotions: 1, assignments: 1 });
  } finally { controller.abort(); await pending; await value.dispose(); }
}, 180_000);

it('fails closed when the real deadline expires before completion identity becomes available', async () => {
  boundary.blockCompletionIdentity = true;
  const value = await completionPhaseFixture({ mode: 'wait', jobTimeoutMs: 1000 });
  try {
    await expect(value.run()).rejects.toMatchObject({ code: 'PROCESS_STATE_UNKNOWN' });
    await expect(value.session.assertStopped()).rejects.toMatchObject({ code: 'PROCESS_STATE_UNKNOWN' });
    const state = await value.session.slot.store.read();
    expect(state).toMatchObject({
      prebuilt: { createEffect: 'accepted', promoteEffect: 'accepted', promotionVerified: true },
      completion: { status: 'unknown', attempts: [{ status: 'unknown', jobs: [{ status: 'unknown' }] }] } });
    const command = state?.processes.find(item => item.name === 'completion:0');
    expect(command).toMatchObject({ status: 'unknown', closure: { requestedTermination: 'timeout',
      ownedScope: { status: 'unknown', reason: 'terminated', empty: true } } });
    if (!command) throw new Error('real completion command required');
    expect(hasVerifiedManagedStop(command)).toBe(false); expect(hasVerifiedManagedClosure(command)).toBe(false);
    expect(await value.results()).toHaveLength(0);
    expect(await value.counts()).toEqual({ creates: 1, promotions: 1, assignments: 1 });
  } finally { await value.dispose(); }
}, 180_000);
