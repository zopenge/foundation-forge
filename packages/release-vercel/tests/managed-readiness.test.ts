import { expect, it, vi } from 'vitest';
import type { ReleaseReport } from '../src/contracts.js';
import { waitForManagedReady } from './helpers/managed-readiness.js';

const failed: ReleaseReport = { schemaVersion: 2, command: 'publish', ok: false, startedAt: '', finishedAt: '',
  stage: 'install', effects: { developmentPush: 'not-attempted', releasePush: 'not-attempted' },
  steps: [{ name: 'install', ok: false, durationMs: 5, exitCode: 23 }], error: { code: 'CHECK_FAILED', details: { step: 'install' } } };

it('reports a finished release before waiting out the unrelated marker deadline', async () => {
  vi.useFakeTimers();
  const controller = new AbortController(); let failure: unknown;
  const task = waitForManagedReady(Promise.resolve(failed), async () => false,
    { timeoutMs: 1000, signal: controller.signal }).catch(error => { failure = error; });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain('CHECK_FAILED');
    expect(vi.getTimerCount()).toBe(0);
  } finally { controller.abort(); await task; vi.useRealTimers(); }
});

it('preserves a rejected phase task before the marker exists', async () => {
  vi.useFakeTimers(); const failure = new Error('original phase failure');
  try {
    await expect(waitForManagedReady(Promise.reject(failure), async () => false)).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it('retains the original readiness deadline and clears every private timer', async () => {
  vi.useFakeTimers(); let failure: unknown;
  const task = waitForManagedReady(new Promise(() => {}), async () => false, { timeoutMs: 1000 })
    .catch(error => { failure = error; });
  try {
    await vi.advanceTimersByTimeAsync(999); expect(failure).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1); await task;
    expect(String(failure)).toContain('readiness timed out'); expect(vi.getTimerCount()).toBe(0);
  } finally { await task; vi.useRealTimers(); }
});

it('preserves an observation error without treating it as a missing marker', async () => {
  vi.useFakeTimers();
  const denied = Object.assign(new Error('read denied'), { code: 'EPERM' });
  try {
    await expect(waitForManagedReady(new Promise(() => {}), async () => { throw denied; })).rejects.toBe(denied);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it('drains an overlapping observation before reporting the finished release', async () => {
  vi.useFakeTimers();
  let finishRead: ((value: boolean) => void) | undefined, settled = false;
  const observation = new Promise<boolean>(accept => { finishRead = accept; });
  const observe = vi.fn(() => observation);
  const task = waitForManagedReady(Promise.resolve(failed), observe).catch(() => { settled = true; });
  try {
    await vi.advanceTimersByTimeAsync(0); expect(settled).toBe(false);
    finishRead?.(false); await task;
    expect(settled).toBe(true); expect(observe).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  } finally { finishRead?.(false); await task; vi.useRealTimers(); }
});

it('returns on the real marker and does not retain a polling timer', async () => {
  vi.useFakeTimers();
  try {
    await waitForManagedReady(new Promise(() => {}), async () => true);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it.each(['deadline', 'cancel'] as const)('rejects a late marker after an inflight read crosses %s', async kind => {
  vi.useFakeTimers();
  const controller = new AbortController(), cancelled = new Error('readiness caller cancelled');
  let finishRead: ((value: boolean) => void) | undefined, failure: unknown;
  const observation = new Promise<boolean>(accept => { finishRead = accept; });
  const task = waitForManagedReady(new Promise(() => {}), () => observation, { timeoutMs: 1000, signal: controller.signal })
    .catch(error => { failure = error; });
  try {
    await vi.advanceTimersByTimeAsync(0);
    if (kind === 'deadline') await vi.advanceTimersByTimeAsync(1000); else controller.abort(cancelled);
    finishRead?.(true); await task;
    if (kind === 'deadline') expect(String(failure)).toContain('readiness timed out'); else expect(failure).toBe(cancelled);
    expect(vi.getTimerCount()).toBe(0);
  } finally { controller.abort(); finishRead?.(false); await task; vi.useRealTimers(); }
});

it('starts the marker deadline at the completion command request instead of unrelated publication preparation', async () => {
  vi.useFakeTimers();
  const controller = new AbortController(); let start: (() => void) | undefined, failure: unknown;
  const started = new Promise<void>(accept => { start = accept; });
  const task = waitForManagedReady(new Promise(() => {}), async () => false, { timeoutMs: 1000, started, signal: controller.signal })
    .catch(error => { failure = error; });
  try {
    await vi.advanceTimersByTimeAsync(5000); expect(failure).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
    start?.(); await vi.advanceTimersByTimeAsync(999); expect(failure).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1); await task;
    expect(String(failure)).toContain('readiness timed out'); expect(vi.getTimerCount()).toBe(0);
  } finally { controller.abort(); start?.(); await task; vi.useRealTimers(); }
});

it('drains cancellation while the completion request has not started', async () => {
  vi.useFakeTimers(); const controller = new AbortController(), reason = new Error('cancel before command');
  const observe = vi.fn(async () => false);
  const task = waitForManagedReady(new Promise(() => {}), observe, { signal: controller.signal, started: new Promise(() => {}) });
  const checked = expect(task).rejects.toBe(reason);
  try { controller.abort(reason); await checked; expect(observe).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0); }
  finally { controller.abort(reason); await task.catch(() => {}); vi.useRealTimers(); }
});

it('retains a release failure before the completion request without starting a marker poll', async () => {
  vi.useFakeTimers(); const observe = vi.fn(async () => false), failure = new Error('preparation failed');
  try {
    await expect(waitForManagedReady(Promise.reject(failure), observe, { started: new Promise(() => {}) })).rejects.toBe(failure);
    expect(observe).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it.each(['resolve', 'reject'] as const)('observes a late release %s after an already cancelled caller', async kind => {
  vi.useFakeTimers(); const controller = new AbortController(), reason = new Error('already cancelled'); controller.abort(reason);
  let accept: ((report: ReleaseReport) => void) | undefined, reject: ((error: Error) => void) | undefined;
  const pending = new Promise<ReleaseReport>((resolve, fail) => { accept = resolve; reject = fail; });
  const observe = vi.fn(async () => false);
  try {
    await expect(waitForManagedReady(pending, observe, { signal: controller.signal, started: new Promise(() => {}) })).rejects.toBe(reason);
    if (kind === 'resolve') accept?.(failed); else reject?.(new Error('late original rejection'));
    await vi.advanceTimersByTimeAsync(0);
    expect(observe).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
