import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { observeBudget } from '../src/node/managed-budget.js';
import { ReleaseError } from '../src/node/errors.js';
import { createManagedSession } from '../src/node/managed-process.js';
import { managedSessionFixture } from './helpers/managed-session-fixture.js';
import type { ManagedSession } from '../src/node/managed-session-contracts.js';
import { managedCommandIdentities } from '../src/node/managed-observation.js';
import { identityReader } from '../src/node/process-identities.js';
import { closeFixtureIdentity } from './helpers/close-fixture-process.js';

const fixtures: Awaited<ReturnType<typeof managedSessionFixture>>[] = [];
const sessions: ManagedSession[] = [];
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks();
  for (const session of sessions.splice(0)) for (const identity of session.state.processes.flatMap(managedCommandIdentities)) {
    const observed = await identityReader().readIdentity({ pid: identity.pid, signal: AbortSignal.timeout(10_000) });
    if (observed.status === 'FOUND' && observed.identity.startToken === identity.startToken) await closeFixtureIdentity(identity);
  }
  for (const f of fixtures.splice(0)) await f.dispose();
});

it('bounds an observation at the original deadline and reports content-free progress', async () => {
  const f = await managedSessionFixture(); fixtures.push(f);
  if (f.config.source.mode !== 'managed-commit') throw new Error('managed source fixture is required');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let enter!: () => void, drained = false;
  const entered = new Promise<void>(accept => { enter = accept; });
  const pending = observeBudget(f.slot.paths, { ...f.config.source, sampleIntervalMs: 1000 }, async (_paths, signal) => {
    if (!signal) throw new Error('observation signal is missing');
    enter();
    return new Promise<never>((_accept, reject) => { signal.addEventListener('abort', () => {
      drained = true; reject(new ReleaseError('BUDGET_UNKNOWN', { reason: 'OBSERVATION_DEADLINE' }));
    }, { once: true }); });
  });
  const result = pending.then(value => ({ value }), (error: unknown) => ({ error }));
  await entered; await vi.advanceTimersByTimeAsync(31_000);
  expect(await result).toMatchObject({ error: { code: 'BUDGET_UNKNOWN', details: {
    reason: 'OBSERVATION_DEADLINE', budgetMs: 31_000, scanAttempts: 1, entriesVisited: 0, phase: 'scan',
    elapsedMs: expect.any(Number), observedAt: expect.any(String),
  } } });
  expect(drained).toBe(true); expect(vi.getTimerCount()).toBe(0);
});

it('shares the original observation deadline across regular subtree rescans', async () => {
  const f = await managedSessionFixture(); fixtures.push(f); await mkdir(f.slot.paths.checkoutRoot);
  if (f.config.source.mode !== 'managed-commit') throw new Error('managed source fixture is required');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const enters: (() => void)[] = [];
  const entered = Array.from({ length: 3 }, () => new Promise<void>(accept => { enters.push(accept); }));
  let attempts = 0, settled = false;
  const result = observeBudget(f.slot.paths, { ...f.config.source, sampleIntervalMs: 1000 }, async (_paths, signal) => {
    if (!signal) throw new Error('observation signal is missing');
    const index = attempts++; enters[index]?.();
    if (index < 2) {
      await new Promise<void>(accept => { setTimeout(accept, 12_000); });
      throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'DIRECTORY_REPLACED', change: 'identity', scope: 'checkout-entry' });
    }
    return new Promise<never>((_accept, reject) => { signal.addEventListener('abort', () => {
      reject(new ReleaseError('BUDGET_UNKNOWN', { reason: 'OBSERVATION_DEADLINE' }));
    }, { once: true }); });
  }).then(value => ({ value }), (error: unknown) => ({ error })).finally(() => { settled = true; });
  const reach = async (index: number) => Promise.race([entered[index], result.then(value => {
    throw new Error('observation ended before the expected scan', { cause: value });
  })]);
  try {
    for (const index of [0, 1]) { await reach(index); await vi.advanceTimersByTimeAsync(12_000); }
    await reach(2); await vi.advanceTimersByTimeAsync(6999); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(settled).toBe(true);
    expect(await result).toMatchObject({ error: { code: 'BUDGET_UNKNOWN', details: {
      reason: 'OBSERVATION_DEADLINE', budgetMs: 31_000, scanAttempts: 3,
    } } });
    expect(vi.getTimerCount()).toBe(0);
  } finally { await vi.runAllTimersAsync(); await result; }
});

it('adds bounded progress to a normalized observation failure without exposing its message', async () => {
  const f = await managedSessionFixture({ sampleIntervalMs: 1000 }); fixtures.push(f);
  if (f.config.source.mode !== 'managed-commit') throw new Error('managed source fixture is required');
  await expect(observeBudget(f.slot.paths, f.config.source, async (_paths, _signal, progress) => {
    if (progress) { progress.entriesVisited = 7; progress.phase = 'entry'; }
    throw new Error('unreported private error message');
  })).rejects.toMatchObject({ code: 'BUDGET_UNKNOWN', details: {
    reason: 'OBSERVATION_FAILED', budgetMs: 31_000, scanAttempts: 1, entriesVisited: 7, phase: 'entry',
    elapsedMs: expect.any(Number), observedAt: expect.any(String),
  } });
});

it('retains a real command failure context when a later budget observation is unknown', async () => {
  const f = await managedSessionFixture(); fixtures.push(f); await mkdir(f.slot.paths.checkoutRoot);
  const session = await createManagedSession(f.slot, 'check'), sample = session.budget.sample.bind(session.budget);
  sessions.push(session);
  vi.spyOn(session.budget, 'sample').mockImplementation(async () => {
    if (session.state.processes.at(-1)?.closure?.exitCode === 23) throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'OBSERVATION_DEADLINE' });
    await sample();
  });
  await expect(session.execution.run('failed-before-final-sample', { command: 'node', args: ['-e', 'process.exit(23)'] }, 'CHECK_FAILED'))
    .rejects.toMatchObject({ code: 'BUDGET_UNKNOWN', details: { reason: 'OBSERVATION_DEADLINE',
      step: 'failed-before-final-sample', commandTermination: 'exit', commandExitCode: 23, commandObservedAt: expect.any(String) } });
  expect(session.state.processes.at(-1)?.closure?.exitCode).toBe(23);
  await session.assertStopped(); await f.slot.lock.release();
});

it('preserves a real timeout and its observed outcome when the final budget observation fails', async () => {
  const f = await managedSessionFixture(); fixtures.push(f); await mkdir(f.slot.paths.checkoutRoot);
  const session = await createManagedSession(f.slot, 'check'), sample = session.budget.sample.bind(session.budget);
  sessions.push(session);
  vi.spyOn(session.budget, 'sample').mockImplementation(async () => {
    if (session.state.processes.at(-1)?.closure?.requestedTermination === 'timeout') throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'OBSERVATION_DEADLINE' });
    await sample();
  });
  const marker = resolve(f.slot.paths.checkoutRoot, 'timeout-payload');
  await expect(session.execution.run('timeout-before-final-sample', { command: 'node', timeoutMs: 10_000,
    args: ['-e', 'require("node:fs").writeFileSync(process.argv[1],"started");setInterval(()=>{},20)', marker] }, 'CHECK_FAILED'))
    .rejects.toMatchObject({ code: 'BUDGET_UNKNOWN', details: { reason: 'OBSERVATION_DEADLINE',
      step: 'timeout-before-final-sample', commandTermination: 'timeout', commandExitCode: null, commandObservedAt: expect.any(String) } });
  expect(await readFile(marker, 'utf8')).toBe('started');
  expect(session.state.processes.at(-1)?.closure?.requestedTermination).toBe('timeout');
  await session.assertStopped(); await f.slot.lock.release();
});
