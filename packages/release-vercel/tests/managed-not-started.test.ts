import { mkdir, readFile, stat } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createManagedSession } from '../src/node/managed-process.js';
import { inspectManagedRecovery } from '../src/node/managed-recovery.js';
import { hasVerifiedManagedClosure, hasVerifiedManagedStop } from '../src/node/managed-closure.js';
import { managedSessionFixture } from './helpers/managed-session-fixture.js';
import { parseManagedState } from '../src/node/managed-state.js';
import { checkoutObservationPlan, matchesObservationBinding } from '../src/node/managed-observation.js';
import type { ManagedCommand } from '../src/node/release-context.js';
import { restoreManagedTerminal } from '../src/node/managed-terminal.js';

// 统计真实 runner 的调用，不替换其启动、身份、Job 或关闭实现。
const starts = vi.hoisted(() => ({ count: 0 }));
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof filesystem>() }));
vi.mock('@openge/forge-command-runner/node', async importOriginal => {
  const native = await importOriginal<typeof import('@openge/forge-command-runner/node')>();
  return { ...native, createNodeCommandRunner: (...args: Parameters<typeof native.createNodeCommandRunner>) => {
    const runner = native.createNodeCommandRunner(...args);
    return { ...runner, start: (...args: Parameters<typeof runner.start>) => { starts.count++; return runner.start(...args); } };
  } };
});

it('rejects malformed, contradictory and unsealed non-start records, including batch-level claims', async () => {
  const f = await managedSessionFixture(); fixtures.push(f);
  const session = await createManagedSession(f.slot, 'check'), id = randomUUID();
  // 只验证持久格式；这份合成摘要从不用于真实停止或恢复。
  const command: ManagedCommand = { id, name: 'cancelled', status: 'stopped', descendants: [], observationComplete: true,
    terminalSha256: 'a'.repeat(64), notStarted: { schemaVersion: 1, reason: 'cancelled-before-runner',
      binding: `${session.state.runId}:${id}:${randomUUID()}`, observedAt: '2026-01-01T00:00:00.000Z' } };
  const state = { ...session.state, processes: [command] };
  expect(() => parseManagedState(state, f.source, f.slot.slotId)).not.toThrow();
  await expect(restoreManagedTerminal(f.slot.paths, state)).rejects.toMatchObject({ code: 'SLOT_STATE', details: { reason: 'TERMINAL_MISSING' } });
  for (const change of [
    { notStarted: { ...command.notStarted, observedAt: 0 } },
    { notStarted: { ...command.notStarted, binding: `${randomUUID()}:${id}:${randomUUID()}` } },
    { notStarted: { ...command.notStarted, schemaVersion: 2 } },
    { notStarted: undefined }, { terminalSha256: undefined }, { pid: 123 },
    { identity: { pid: 123, startToken: 'fixture-instance' } },
    { scope: { scopeId: randomUUID(), binding: command.notStarted?.binding } },
    { closure: { observedAt: '2026-01-01T00:00:00.000Z', exitCode: null, termination: 'abort' } },
    { descendants: [{ pid: 123, startToken: 'fixture-instance' }] },
  ]) expect(() => parseManagedState({ ...state, processes: [{ ...command, ...change }] }, f.source, f.slot.slotId)).toThrow();
  const batch = { id, name: 'checkout-frozen', kind: 'checkout-observation', status: 'unknown', descendants: [],
    observationComplete: false, observations: [], plan: checkoutObservationPlan(f.source), notStarted: command.notStarted };
  expect(() => parseManagedState({ ...state, processes: [batch] }, f.source, f.slot.slotId)).toThrow();
});

it('keeps historical unproved cancellation unknown even when a report diagnostic says aborted before start', async () => {
  const f = await managedSessionFixture(); fixtures.push(f);
  const session = await createManagedSession(f.slot, 'check');
  const state = parseManagedState({ ...session.state, status: 'unknown', processes: [{
    id: randomUUID(), name: 'git-stream', status: 'unknown', descendants: [], observationComplete: false,
    closure: { observedAt: '2026-01-01T00:00:00.000Z', exitCode: null, termination: 'abort' },
    diagnostics: [{ code: 'COMMAND_ABORTED_BEFORE_START' }],
  }] }, f.source, f.slot.slotId);
  expect(state.processes.every(hasVerifiedManagedStop)).toBe(false);
  expect((await inspectManagedRecovery(state, f.slot.paths)).processes).toBe('unknown');
});

it('keeps an unstarted intent unknown when its independent proof cannot be committed', async () => {
  const f = await managedSessionFixture(); fixtures.push(f); await mkdir(f.slot.paths.checkoutRoot);
  const session = await createManagedSession(f.slot, 'check');
  const controller = new AbortController(), sample = session.budget.sample.bind(session.budget);
  vi.spyOn(session.budget, 'sample').mockImplementationOnce(async () => { await sample(); controller.abort(); });
  const rename = filesystem.rename, terminalPath = resolve(f.slot.paths.slotRoot, 'terminal.json');
  vi.spyOn(filesystem, 'rename').mockImplementation(async (from, to) => {
    if (String(to) === terminalPath) throw Object.assign(new Error('private proof rename failure'), { code: 'EBUSY' });
    await rename(from, to);
  });
  await expect(session.execution.run('unsealed-cancellation', { command: 'node', args: ['-e', 'process.exit(0)'] },
    'CHECK_FAILED', undefined, controller.signal)).rejects.toMatchObject({ code: 'PROCESS_STATE_UNKNOWN' });
  expect(starts.count).toBe(0);
  const disk = await f.slot.store.read(), command = disk?.processes.at(-1);
  expect(command).toMatchObject({ status: 'unknown', observationComplete: false });
  expect(command?.notStarted).toBeUndefined(); expect(command?.terminalSha256).toBeUndefined();
  expect(disk && (await inspectManagedRecovery(disk, f.slot.paths)).processes).toBe('unknown');
});

it('restores a sealed non-start witness without rewriting an interrupted ordinary state commit', async () => {
  const f = await managedSessionFixture(); fixtures.push(f); await mkdir(f.slot.paths.checkoutRoot);
  const session = await createManagedSession(f.slot, 'check');
  const controller = new AbortController(), sample = session.budget.sample.bind(session.budget);
  vi.spyOn(session.budget, 'sample').mockImplementationOnce(async () => { await sample(); controller.abort(); });
  const writeState = f.slot.store.writeState.bind(f.slot.store);
  vi.spyOn(f.slot.store, 'writeState').mockImplementation(async (state, beforeCommit) => {
    if (state.processes.at(-1)?.status === 'stopped') throw Object.assign(new Error('interrupted state commit'), { code: 'EBUSY' });
    await writeState(state, beforeCommit);
  });
  await expect(session.execution.run('state-interrupted', { command: 'node', args: ['-e', 'process.exit(0)'] },
    'CHECK_FAILED', undefined, controller.signal)).rejects.toMatchObject({ code: 'PROCESS_STATE_UNKNOWN' });
  expect(starts.count).toBe(0);
  const before = await readFile(f.slot.paths.statePath, 'utf8'), disk = await f.slot.store.read();
  expect(disk?.processes.at(-1)).toMatchObject({ status: 'intent', observationComplete: false });
  expect(disk?.processes.at(-1)?.notStarted).toBeUndefined();
  if (!disk) throw new Error('state fixture is missing');
  const restored = await restoreManagedTerminal(f.slot.paths, disk);
  expect(restored.state.processes.at(-1)).toMatchObject({ status: 'stopped', observationComplete: true,
    notStarted: { reason: 'cancelled-before-runner' } });
  expect(restored.state.processes.every(hasVerifiedManagedStop)).toBe(true);
  expect(restored.state.processes.every(hasVerifiedManagedClosure)).toBe(false);
  expect(await readFile(f.slot.paths.statePath, 'utf8')).toBe(before);
  await session.assertStopped();
  expect((await inspectManagedRecovery(restored.state, f.slot.paths)).processes).toBe('closed');
  await f.slot.lock.release();
});
const fixtures: Awaited<ReturnType<typeof managedSessionFixture>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); starts.count = 0; for (const f of fixtures.splice(0)) await f.dispose(); });

it('cannot merge a non-start proof over any historical launch evidence or unknown result', () => {
  const id = randomUUID(), binding = `${randomUUID()}:${id}:${randomUUID()}`;
  const proof: ManagedCommand = { id, name: 'cancelled', status: 'stopped', descendants: [], observationComplete: true,
    notStarted: { schemaVersion: 1, reason: 'cancelled-before-runner', binding, observedAt: '2026-01-01T00:00:00.000Z' } };
  const intent: ManagedCommand = { id, name: 'cancelled', status: 'intent', descendants: [], observationComplete: false };
  expect(matchesObservationBinding(intent, proof)).toBe(true);
  expect(matchesObservationBinding(proof, proof)).toBe(true);
  for (const change of [
    { status: 'unknown' as const }, { status: 'spawned' as const }, { status: 'identified' as const },
    { pid: 123 }, { identity: { pid: 123, startToken: 'fixture-instance' } },
    { scope: { scopeId: randomUUID(), binding } }, { descendants: [{ pid: 123, startToken: 'fixture-instance' }] },
    { closure: { observedAt: '2026-01-01T00:00:00.000Z', exitCode: null, termination: 'abort' as const } },
  ]) expect(matchesObservationBinding({ ...intent, ...change }, proof)).toBe(false);
});

it('durably records cancellation after intent but before runner invocation without inventing OS closure', async () => {
  const f = await managedSessionFixture(); fixtures.push(f); await mkdir(f.slot.paths.checkoutRoot);
  const session = await createManagedSession(f.slot, 'check');
  const controller = new AbortController(), sample = session.budget.sample.bind(session.budget);
  vi.spyOn(session.budget, 'sample').mockImplementationOnce(async () => { await sample(); controller.abort(); });
  const marker = resolve(f.slot.paths.checkoutRoot, 'must-not-start');
  await expect(session.execution.run('cancel-before-start', { command: 'node', args: ['-e',
    'require("node:fs").writeFileSync(process.argv[1],"unexpected")', marker] }, 'CHECK_FAILED', undefined, controller.signal))
    .rejects.toMatchObject({ code: 'CANCELLED' });
  expect(starts.count).toBe(0);
  await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  const disk = await f.slot.store.read(), command = disk?.processes.at(-1);
  expect(command).toMatchObject({ status: 'stopped', observationComplete: true,
    notStarted: { schemaVersion: 1, reason: 'cancelled-before-runner' }, terminalSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
  expect(command?.identity).toBeUndefined(); expect(command?.pid).toBeUndefined();
  expect(command?.scope).toBeUndefined(); expect(command?.closure).toBeUndefined();
  expect(command && hasVerifiedManagedStop(command)).toBe(true);
  expect(command && hasVerifiedManagedClosure(command)).toBe(false);
  const terminal = JSON.parse(await readFile(resolve(f.slot.paths.slotRoot, 'terminal.json'), 'utf8'));
  expect(terminal.command.notStarted.reason).toBe('cancelled-before-runner');
  await expect(session.assertClosed()).rejects.toMatchObject({ code: 'PROCESS_STATE_UNKNOWN' });
  await session.assertStopped();
  expect(disk && (await inspectManagedRecovery(disk, f.slot.paths)).processes).toBe('closed');
  await f.slot.lock.release();
});
