import { mkdir, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, expect, it, vi } from 'vitest';
import { observeBudget } from '../src/node/managed-budget.js';
import { measureManagedUsageOnce } from '../src/node/managed-io.js';
import { ReleaseError } from '../src/node/errors.js';
import { managedBudgetFixture } from './helpers/managed-budget-fixture.js';

const checkpoint = vi.hoisted(() => ({ path: '', wait: async () => {} }));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, lstat: async (...args: Parameters<typeof fs.lstat>) => {
    if (args[0] === checkpoint.path) await checkpoint.wait();
    return fs.lstat(...args);
  } };
});
const fixtures: Awaited<ReturnType<typeof managedBudgetFixture>>[] = [];
const fixture = async () => {
  const f = await managedBudgetFixture(); fixtures.push(f);
  return { ...f, limits: { ...f.limits, sampleIntervalMs: 1000 } };
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
};
const failure = async (work: Promise<unknown>): Promise<ReleaseError> => {
  try { await work; } catch (error) { if (error instanceof ReleaseError) return error; throw error; }
  throw new Error('expected observation failure');
};
afterEach(async () => {
  checkpoint.path = ''; checkpoint.wait = async () => {};
  vi.useRealTimers(); vi.restoreAllMocks();
  const errors: unknown[] = [];
  for (const f of fixtures.splice(0)) {
    try { await f.lock.release(); } catch (error) { errors.push(error); }
    try { await f.dispose(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'attempt fixture cleanup failed');
});

it('records each settled attempt and witnesses retries only when the next scan starts', async () => {
  const f = await fixture(); let now = 0, calls = 0;
  await mkdir(f.paths.checkoutRoot);
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const error = await failure(observeBudget(f.paths, f.limits, async (_paths, _signal, progress) => {
    calls++;
    if (progress) { progress.entriesVisited = calls * 7; progress.phase = 'entry'; }
    now += calls * 11;
    if (calls === 1) throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'IO_OBSERVATION', ioCode: 'ENOENT', entry: 'PRIVATE_SENTINEL' });
    if (calls === 2) throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'DIRECTORY_REPLACED', change: 'identity', scope: 'checkout-entry' });
    throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'ENTRY_LIMIT' });
  }));
  expect(error.details).toMatchObject({ reason: 'ENTRY_LIMIT', scanAttempts: 3, entriesVisited: 21 });
  expect(error.details.scanAttemptDiagnostics).toEqual([
    { attempt: 1, startedOffsetMs: 0, endedOffsetMs: 11, elapsedMs: 11, outcome: 'rejected', retried: true,
      entriesVisited: 7, phase: 'entry', failure: { reason: 'IO_OBSERVATION', ioCode: 'ENOENT' }, failureWitness: { selection: 'unwitnessed' } },
    { attempt: 2, startedOffsetMs: 11, endedOffsetMs: 33, elapsedMs: 22, outcome: 'rejected', retried: true,
      entriesVisited: 14, phase: 'entry', failure: { reason: 'DIRECTORY_REPLACED', change: 'identity', scope: 'checkout-entry' }, failureWitness: { selection: 'unwitnessed' } },
    { attempt: 3, startedOffsetMs: 33, endedOffsetMs: 66, elapsedMs: 33, outcome: 'rejected', retried: false,
      entriesVisited: 21, phase: 'entry', failure: { reason: 'ENTRY_LIMIT' }, failureWitness: { selection: 'unwitnessed' } },
  ]);
});

it('retains the first error and blocking witness without inventing a retry', async () => {
  const f = await fixture(); let calls = 0;
  const error = await failure(observeBudget(f.paths, f.limits, async () => {
    calls++; throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'IO_OBSERVATION', ioCode: 'ENOENT',
      rescanBlockedBy: 'LINK_REPLACED', entry: 'original-entry' });
  }));
  expect(calls).toBe(1);
  expect(error.details).toMatchObject({ reason: 'IO_OBSERVATION', ioCode: 'ENOENT', rescanBlockedBy: 'LINK_REPLACED', entry: 'original-entry' });
  expect(error.details.scanAttemptDiagnostics).toEqual([expect.objectContaining({ outcome: 'rejected', retried: false,
    failure: { reason: 'IO_OBSERVATION', ioCode: 'ENOENT', rescanBlockedBy: 'LINK_REPLACED' } })]);
});

it('keeps unknown strings and error content out of attempt summaries', async () => {
  const f = await fixture();
  const error = await failure(observeBudget(f.paths, f.limits, async () => {
    throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'PRIVATE_SENTINEL', ioCode: 'PRIVATE_SENTINEL',
      rescanBlockedBy: 'PRIVATE_SENTINEL', entry: 'PRIVATE_SENTINEL', change: 'PRIVATE_SENTINEL', scope: 'PRIVATE_SENTINEL' });
  }));
  expect(error.details.reason).toBe('PRIVATE_SENTINEL');
  expect(error.details.scanAttemptDiagnostics).toEqual([expect.objectContaining({
    failure: { reason: 'OTHER', ioCode: 'OTHER', rescanBlockedBy: 'OTHER' },
  })]);
  expect(JSON.stringify(error.details.scanAttemptDiagnostics)).not.toContain('PRIVATE_SENTINEL');
});

it('does not change successful results or non-UNKNOWN failures', async () => {
  const f = await fixture(), value = await observeBudget(f.paths, f.limits);
  expect(Object.keys(value)).toEqual(['bytes', 'freeBytes', 'observedAt']);
  const original = new ReleaseError('SLOT_STATE', { reason: 'private-non-budget-error' });
  const error = await failure(observeBudget(f.paths, f.limits, async () => { throw original; }));
  expect(error).toBe(original); expect(error.details).toEqual({ reason: 'private-non-budget-error' });
});

it('distinguishes a returned scan from a rejected checkout guard', async () => {
  const f = await fixture(); await mkdir(f.paths.checkoutRoot);
  const error = await failure(observeBudget(f.paths, f.limits, async (...args) => {
    const value = await measureManagedUsageOnce(...args);
    await rename(f.paths.checkoutRoot, resolve(f.root, 'previous-checkout'));
    await mkdir(f.paths.checkoutRoot);
    return value;
  }));
  expect(error.details).toMatchObject({ reason: 'DIRECTORY_REPLACED', scope: 'checkout-root', change: 'identity', scanAttempts: 1 });
  expect(error.details.scanAttemptDiagnostics).toEqual([expect.objectContaining({ outcome: 'resolved', retried: false, phase: 'complete' })]);
  expect(error.details.scanAttemptDiagnostics).toEqual([expect.not.objectContaining({ failure: expect.anything() })]);
});

it.each(['before-scan', 'after-scan'] as const)('records a deadline in a %s guard without inventing a pending scan', async mode => {
  const f = await fixture(); await mkdir(f.paths.checkoutRoot);
  const entered = deferred(), held = deferred(), left = deferred();
  let calls = 0, checkpointEntered = false;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  checkpoint.wait = async () => {
    checkpointEntered = true; entered.resolve();
    try { await held.promise; throw new Error('private released guard'); } finally { left.resolve(); }
  };
  if (mode === 'before-scan') checkpoint.path = f.paths.sourceRoot;
  const result = failure(observeBudget(f.paths, f.limits, async (...args) => {
    calls++; const value = await measureManagedUsageOnce(...args);
    checkpoint.path = f.paths.checkoutRoot; return value;
  }));
  try {
    await Promise.race([entered.promise, result.then(error => { throw error; })]);
    await vi.advanceTimersByTimeAsync(31_000);
    const error = await result;
    expect(error.details).toMatchObject({ reason: 'OBSERVATION_DEADLINE', budgetMs: 31_000, scanAttempts: calls });
    if (mode === 'before-scan') { expect(calls).toBe(0); expect(error.details.scanAttemptDiagnostics).toEqual([]); }
    else {
      expect(calls).toBe(1);
      expect(error.details.scanAttemptDiagnostics).toEqual([expect.objectContaining({ outcome: 'resolved', retried: false, phase: 'complete' })]);
    }
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    held.resolve(); if (checkpointEntered) await left.promise; await result;
  }
});

it('freezes three attempts at the shared deadline before abort and late settlement', async () => {
  const f = await fixture(), entered = deferred(), held = deferred();
  let now = 0, calls = 0;
  const scans: Promise<{ bytes: number; freeBytes: number }>[] = [];
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const result = failure(observeBudget(f.paths, f.limits, (...args) => {
    const task = (async () => {
      calls++; const progress = args[2];
      if (progress) { progress.entriesVisited = calls * 5; progress.phase = 'entry'; }
      if (calls < 3) {
        now += 1000;
        throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'IO_OBSERVATION', ioCode: 'ENOENT' });
      }
      args[1]?.addEventListener('abort', () => { if (progress) progress.entriesVisited = 999; }, { once: true });
      entered.resolve(); await held.promise;
      if (progress) { progress.entriesVisited = 1000; progress.phase = 'complete'; }
      throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'LINK_REPLACED' });
    })();
    scans.push(task); return task;
  }));
  try {
    await Promise.race([entered.promise, result.then(error => { throw error; })]);
    now = 31_000; await vi.advanceTimersByTimeAsync(31_000);
    const error = await result, frozen = JSON.stringify(error.details);
    expect(error.details).toMatchObject({ reason: 'OBSERVATION_DEADLINE', budgetMs: 31_000, scanAttempts: 3, entriesVisited: 15 });
    expect(error.details.scanAttemptDiagnostics).toEqual([
      expect.objectContaining({ attempt: 1, elapsedMs: 1000, outcome: 'rejected', retried: true, entriesVisited: 5 }),
      expect.objectContaining({ attempt: 2, elapsedMs: 1000, outcome: 'rejected', retried: true, entriesVisited: 10 }),
      { attempt: 3, startedOffsetMs: 2000, elapsedMs: 29000, outcome: 'pending', retried: false, entriesVisited: 15, phase: 'entry' },
    ]);
    now = 32_000; held.resolve(); await Promise.allSettled(scans);
    expect(JSON.stringify(error.details)).toBe(frozen); expect(vi.getTimerCount()).toBe(0);
  } finally { held.resolve(); await Promise.allSettled(scans); await result; }
});
