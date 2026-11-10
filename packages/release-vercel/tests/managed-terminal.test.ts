import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createManagedSession } from '../src/node/managed-process.js';
import { managedSessionFixture as managedFixture } from './helpers/managed-session-fixture.js';
import { identityReader } from '../src/node/process-identities.js';
import { closeFixtureIdentity } from './helpers/close-fixture-process.js';
import type { ManagedSession } from '../src/node/release-context.js';
import * as retirementHost from '../src/node/retirement-host.js';
import { restoreManagedTerminal } from '../src/node/managed-terminal.js';
import { randomUUID } from 'node:crypto';
import { hasVerifiedManagedStop } from '../src/node/managed-closure.js';
import { completionDeadline } from './helpers/completion-deadline.js';
import type { CommandEvent } from '@openge/forge-command-runner';
import { ReleaseError } from '../src/node/errors.js';
import { managedPhaseSession } from './helpers/managed-phase-session.js';

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof filesystem>() }));
const commandClock = vi.hoisted(() => ({ armed: false, value: undefined as ReturnType<typeof completionDeadline> | undefined }));
const startupObservation = vi.hoisted(() => ({ event: undefined as ((event: CommandEvent) => void) | undefined,
  authorized: 0 }));
vi.mock('@openge/forge-command-runner/node', async original => {
  const actual = await original<typeof import('@openge/forge-command-runner/node')>();
  return { ...actual, createNodeCommandRunner: (options: Parameters<typeof actual.createNodeCommandRunner>[0]) => {
    const runner = actual.createNodeCommandRunner({ ...options,
      setTimeout: new Proxy(options?.setTimeout ?? globalThis.setTimeout, { apply(target, receiver, args) {
        return Reflect.apply(commandClock.value?.timers.setTimeout ?? target, receiver, args);
      } }),
      clearTimeout: new Proxy(options?.clearTimeout ?? globalThis.clearTimeout, { apply(target, receiver, args) {
        return Reflect.apply(commandClock.value?.timers.clearTimeout ?? target, receiver, args);
      } }),
    });
    return { ...runner, start: (...args: Parameters<typeof runner.start>) => {
      if (commandClock.armed) {
        const interval = args[0].timeoutMs; if (interval === undefined) throw new Error('bounded timeout request required');
        commandClock.armed = false; commandClock.value = completionDeadline(interval, { once: true });
      }
      const running = runner.start(args[0], event => { args[1]?.(event); startupObservation.event?.(event); });
      const authorize = running.authorizeStart;
      return authorize ? { ...running, authorizeStart: () => { startupObservation.authorized++; return authorize(); } } : running;
    } };
  } };
});

const fixtures: Awaited<ReturnType<typeof managedFixture>>[] = [];
const sessions: ManagedSession[] = [];
afterEach(async () => {
  try {
  vi.restoreAllMocks();
  for (const session of sessions.splice(0)) for (const command of session.state.processes) {
    if (!command.identity) continue;
    const found = await identityReader().readIdentity({ pid: command.identity.pid });
    if (found.status === 'FOUND' && found.identity.startToken === command.identity.startToken) await closeFixtureIdentity(command.identity);
  }
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
  } finally { commandClock.value?.dispose(); commandClock.value = undefined; commandClock.armed = false;
    startupObservation.event = undefined; startupObservation.authorized = 0; }
});
async function fixture() {
  const f = await managedFixture({ sampleIntervalMs: 5000 }); fixtures.push(f);
  const slot = f.slot; await mkdir(slot.paths.checkoutRoot);
  const session = await createManagedSession(slot, 'check'); sessions.push(session);
  return { ...f, slot, session, terminalPath: resolve(slot.paths.slotRoot, 'terminal.json') };
}

it('persists real OS stopping evidence even when a payload link prevents the ordinary journal scan', async () => {
  const f = await fixture(), outside = resolve(f.root, 'outside-slot'); await mkdir(outside);
  const link = resolve(f.slot.paths.checkoutRoot, 'payload-link');
  await expect(f.session.execution.run('payload-failure', { command: 'node', args: ['-e',
    'require("node:fs").symlinkSync(process.argv[1],process.argv[2],"junction");process.exit(23)', outside, link] }, 'CHECK_FAILED'))
    .rejects.toMatchObject({ code: 'BUDGET_UNKNOWN' });
  const terminal = JSON.parse(await readFile(f.terminalPath, 'utf8'));
  expect(terminal).toMatchObject({ schemaVersion: 1, runId: f.slot.runId, slotId: f.slot.slotId,
    command: { name: 'payload-failure', observationComplete: true, closure: { ownedScope: { empty: true } } } });
  expect(['closed', 'stopped']).toContain(terminal.command.status);
  expect(terminal.command.closure.ownedScope.rootIdentity).toEqual(terminal.command.identity);
  expect(terminal.command.closure.ownedScope.binding).toBe(terminal.command.scope.binding);
  const original = await readFile(f.slot.paths.statePath, 'utf8'), disk = await f.slot.store.read();
  if (!disk) throw new Error('state fixture missing');
  const restored = await restoreManagedTerminal(f.slot.paths, disk);
  expect(restored.state.processes[0]).toMatchObject({ observationComplete: true, terminalSha256: expect.any(String) });
  expect(['closed', 'stopped']).toContain(restored.state.processes[0]?.status);
  expect(await readFile(f.slot.paths.statePath, 'utf8')).toBe(original);
});

it('keeps a real nonzero exit failed while durably recording its safe natural stop', async () => {
  const f = await fixture();
  await expect(f.session.execution.run('exit-failure', { command: 'node', args: ['-e', 'process.exit(23)'] }, 'CHECK_FAILED'))
    .rejects.toMatchObject({ code: 'CHECK_FAILED', details: { exitCode: 23 } });
  expect(JSON.parse(await readFile(f.terminalPath, 'utf8'))).toMatchObject({
    command: { status: 'closed', closure: { exitCode: 23, termination: 'exit', ownedScope: { status: 'closed', reason: 'normal', empty: true } } },
  });
  const disk = await f.slot.store.read(); if (!disk) throw new Error('state fixture missing');
  expect((await restoreManagedTerminal(f.slot.paths, disk)).state.processes[0]).toMatchObject({ status: 'closed', closure: { exitCode: 23 } });
  await f.slot.lock.release();
});

it('reports controlled cancellation as cancelled and retains the exact stopped scope', async () => {
  const f = await fixture(), marker = resolve(f.slot.paths.checkoutRoot, 'writer'), controller = new AbortController();
  const pending = f.session.execution.run('cancelled', { command: 'node', args: ['-e',
    'require("node:fs").writeFileSync(process.argv[1],"started");setInterval(()=>require("node:fs").appendFileSync(process.argv[1],"x"),50)', marker] }, 'CHECK_FAILED', undefined, controller.signal);
  const observed = pending.then(value => ({ value }), (error: unknown) => ({ error }));
  try {
    for (let count = 0; count < 100; count++) {
      try { await readFile(marker); break; } catch { await new Promise(accept => setTimeout(accept, 100)); }
    }
  } finally { controller.abort(); }
  expect(await observed).toMatchObject({ error: { code: 'CANCELLED' } });
  expect(JSON.parse(await readFile(f.terminalPath, 'utf8'))).toMatchObject({
    command: { status: 'stopped', observationComplete: true, closure: { ownedScope: { status: 'unknown', reason: 'terminated', empty: true } } },
  });
  const bytes = (await readFile(marker)).length; await new Promise(accept => setTimeout(accept, 150));
  expect((await readFile(marker)).length).toBe(bytes);
});

async function assertQueuedScopeCancellation(mode: 'external' | 'budget' | 'timeout' | 'timeout-during-journal') {
  const timeout = mode === 'timeout' || mode === 'timeout-during-journal';
  const f = await fixture(), marker = resolve(f.slot.paths.checkoutRoot, 'must-not-start'), controller = new AbortController();
  let releaseWrite: () => void = () => {}, enteredWrite: () => void = () => {}, receivedScope: () => void = () => {};
  let enteredSample: () => void = () => {}, failSample: () => void = () => {}, requestedStop: () => void = () => {};
  const writeHeld = new Promise<void>(accept => { releaseWrite = accept; });
  const writeEntered = new Promise<void>(accept => { enteredWrite = accept; });
  const scopeReceived = new Promise<void>(accept => { receivedScope = accept; });
  const sampleEntered = new Promise<void>(accept => { enteredSample = accept; });
  const stopRequested = new Promise<void>(accept => { requestedStop = accept; });
  const budgetFailure = new ReleaseError('BUDGET_UNKNOWN', { reason: 'OBSERVATION_DEADLINE', budgetMs: 35_000 });
  let cleaning = false;
  if (mode === 'budget') {
    const sample = f.session.budget.sample.bind(f.session.budget); let samples = 0;
    vi.spyOn(f.session.budget, 'sample').mockImplementation(async () => {
      if (cleaning || ++samples !== 2) return sample();
      // 只注入周期观察错误；取消与原生停止继续走真实 BudgetMonitor/runner 链。
      await new Promise<never>((_accept, reject) => { failSample = () => reject(budgetFailure); enteredSample(); });
    });
  }
  let scope: Extract<CommandEvent, { type: 'scope-ready' }> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const write = f.slot.store.writeState.bind(f.slot.store);
  vi.spyOn(f.slot.store, 'writeState').mockImplementation(async (...args) => {
    if (args[0].processes.at(-1)?.status === (mode === 'timeout-during-journal' ? 'identified' : 'spawned')) { enteredWrite(); await writeHeld; }
    await write(...args);
  });
  startupObservation.event = event => {
    if (event.type === 'scope-ready') { scope = event; receivedScope(); }
    if (event.type === 'termination-requested' && event.reason === (timeout ? 'timeout' : 'abort')) requestedStop();
  };
  startupObservation.authorized = 0;
  if (timeout) commandClock.armed = true;
  const pending = f.session.execution.run('cancel-before-argv', { command: 'node', args: ['-e',
    'require("node:fs").writeFileSync(process.argv[1],"ran")', marker] }, 'CHECK_FAILED', undefined, controller.signal);
  const observed = pending.then(value => ({ value }), (error: unknown) => ({ error }));
  const deadline = new Promise<never>((_accept, reject) => {
    timer = setTimeout(() => reject(new Error('native startup witnesses not received')), f.config.limits.commandMs);
  });
  try {
    // 只延迟真实 spawned 状态提交；身份、scope 与关闭事实均来自原生 Provider。
    await Promise.race([Promise.all([writeEntered, scopeReceived, ...(mode === 'budget' ? [sampleEntered] : [])]), deadline,
      observed.then(result => { throw new Error('command ended before startup witnesses', { cause: result }); })]);
    if (timeout) {
      const clock = commandClock.value;
      if (!clock || clock.pendingCount() !== 1) throw new Error('command deadline was not captured');
      clock.advance(clock.interval);
    } else if (mode === 'budget') failSample(); else controller.abort();
    await Promise.race([stopRequested, deadline]);
    clearTimeout(timer); releaseWrite();
    const result = await observed;
    if (!scope) throw new Error('real native scope witness missing');
    expect(f.session.state.processes.at(-1)).toMatchObject({ identity: scope.identity,
      scope: { scopeId: scope.scopeId, binding: scope.binding }, status: 'stopped', observationComplete: true,
      closure: { requestedTermination: timeout ? 'timeout' : 'abort', ownedScope: { status: 'unknown', reason: 'terminated', empty: true } } });
    expect(startupObservation.authorized, JSON.stringify(result)).toBe(0);
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(result).toMatchObject({ error: mode === 'budget'
      ? { code: 'BUDGET_UNKNOWN', details: { reason: 'OBSERVATION_DEADLINE', budgetMs: 35_000, step: 'cancel-before-argv' } }
      : { code: timeout ? 'COMMAND_TIMEOUT' : 'CANCELLED' } });
    if (timeout) {
      expect(result).toMatchObject({ error: { details: { preparation: {
        authorization: 'not-requested',
        phaseAtTermination: mode === 'timeout-during-journal' ? 'identified-journal' : 'spawned-journal',
        scopeReadyQueueMs: expect.any(Number), guardMs: expect.any(Number), journalMs: expect.any(Number),
        budgetQueueMs: expect.any(Number), budgetScanMs: expect.any(Number),
        elapsedMs: expect.any(Number), terminationAfterMs: expect.any(Number),
      } } } });
      if (!('error' in result) || !(result.error instanceof ReleaseError)) throw new Error('timeout error missing');
      const preparation = result.error.details.preparation;
      if (!preparation || typeof preparation !== 'object') throw new Error('preparation diagnostic missing');
      const milliseconds = (key: string) => {
        const value: unknown = Reflect.get(preparation, key);
        if (typeof value !== 'number') throw new Error(`timing field missing: ${key}`);
        expect(Number.isFinite(value)).toBe(true); expect(value).toBeGreaterThanOrEqual(0); return value;
      };
      expect(milliseconds('journalMs')).toBeGreaterThan(0);
      expect(milliseconds('elapsedMs')).toBeGreaterThanOrEqual(milliseconds('journalMs'));
      expect(milliseconds('elapsedMs')).toBeGreaterThanOrEqual(milliseconds('scopeReadyQueueMs'));
      if (mode === 'timeout-during-journal') {
        expect(milliseconds('guardMs')).toBeGreaterThan(0); expect(milliseconds('budgetScanMs')).toBeGreaterThan(0);
        expect(milliseconds('budgetMs')).toBeGreaterThanOrEqual(milliseconds('budgetQueueMs') + milliseconds('budgetScanMs'));
      }
      expect(JSON.stringify(preparation)).not.toContain(f.root);
      expect(f.session.steps.at(-1)).toMatchObject({ name: 'cancel-before-argv', ok: false, exitCode: null });
      // 命令与排队工作均已结算；此时输出固定字段不会改变被测授权竞态。
      console.info(JSON.stringify({ event: 'managed-startup-timeout-diagnostic', scenario: mode, preparation }));
    }
    await expect(f.session.assertClosed()).rejects.toMatchObject({ code: 'PROCESS_STATE_UNKNOWN' });
    await expect(f.session.assertStopped()).resolves.toBeUndefined();
    const terminal = JSON.parse(await readFile(f.terminalPath, 'utf8'));
    expect(terminal.command).toMatchObject({ identity: scope.identity, status: 'stopped',
      scope: { scopeId: scope.scopeId, binding: scope.binding } });
  } finally { clearTimeout(timer); cleaning = true; failSample(); controller.abort(); releaseWrite();
    await observed; startupObservation.event = undefined; }
}

it('retains a real scope received behind a pending spawned journal when cancellation forbids argv', async () => {
  await assertQueuedScopeCancellation('external');
});

it('preserves the budget failure while sealing a queued real scope without authorizing argv', async () => {
  await assertQueuedScopeCancellation('budget');
});

it('preserves timeout behind a pending spawned journal without late authorization', async () => {
  await assertQueuedScopeCancellation('timeout');
});

it('preserves timeout during identified journal persistence without late authorization', async () => {
  await assertQueuedScopeCancellation('timeout-during-journal');
});

it('rejects a command whose bounded recovery record cannot fit before its real argv runs', async () => {
  const f = await fixture(), marker = resolve(f.slot.paths.checkoutRoot, 'must-not-run');
  await expect(f.session.execution.run('x'.repeat(262_144), { command: 'node', args: ['-e',
    'require("node:fs").writeFileSync(process.argv[1],"ran")', marker] }, 'CHECK_FAILED'))
    .rejects.toMatchObject({ code: 'BUDGET_EXCEEDED', details: { reason: 'TERMINAL_LIMIT' } });
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not authorize resource reuse when the termination record cannot be written', async () => {
  const f = await fixture(), rename = filesystem.rename;
  vi.spyOn(filesystem, 'rename').mockImplementation(async (from, to) => {
    if (to === f.terminalPath) throw Object.assign(new Error('fixture metadata disk failure'), { code: 'EIO' });
    await rename(from, to);
  });
  await expect(f.session.execution.run('metadata-write-failed', { command: 'node', args: ['-e', 'process.exit(0)'] }, 'CHECK_FAILED'))
    .rejects.toMatchObject({ code: 'PROCESS_STATE_UNKNOWN', details: { causeCode: 'EIO' } });
  await expect(f.session.assertStopped()).rejects.toMatchObject({ code: 'PROCESS_STATE_UNKNOWN' });
  await expect(readFile(f.terminalPath)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects ownership replacement at the atomic termination commit even when bytes are unchanged', async () => {
  const f = await fixture(), rename = filesystem.rename, owner = await readFile(f.slot.paths.ownershipPath);
  vi.spyOn(filesystem, 'rename').mockImplementation(async (from, to) => {
    if (to === f.terminalPath) {
      await rename(f.slot.paths.ownershipPath, `${f.slot.paths.ownershipPath}.original`);
      await writeFile(f.slot.paths.ownershipPath, owner);
    }
    await rename(from, to);
  });
  await expect(f.session.execution.run('owner-replaced', { command: 'node', args: ['-e', 'process.exit(0)'] }, 'CHECK_FAILED'))
    .rejects.toMatchObject({ code: 'SLOT_STATE' });
  await expect(f.session.assertStopped()).rejects.toMatchObject({ code: 'PROCESS_STATE_UNKNOWN' });
});

it('keeps the slot blocked when the observed host changes before the termination receipt', async () => {
  const f = await fixture(), host = f.session.state.host;
  if (!host) throw new Error('host fixture missing');
  vi.spyOn(retirementHost, 'readRetirementHost').mockResolvedValue({ ...host, hostId: 'f'.repeat(64) });
  await expect(f.session.execution.run('host-changed', { command: 'node', args: ['-e', 'process.exit(0)'] }, 'CHECK_FAILED'))
    .rejects.toMatchObject({ code: 'SLOT_STATE', details: { reason: 'TERMINAL_HOST_CHANGED' } });
  await expect(f.session.assertStopped()).rejects.toMatchObject({ code: 'PROCESS_STATE_UNKNOWN' });
});

it('rejects a copied state file after a fully merged stopping receipt', async () => {
  const f = await fixture();
  await f.session.execution.run('state-replaced', { command: 'node', args: ['-e', 'process.exit(0)'] }, 'CHECK_FAILED');
  const disk = await f.slot.store.read(); if (!disk) throw new Error('state fixture missing');
  await expect(restoreManagedTerminal(f.slot.paths, disk)).resolves.toMatchObject({ state: { runId: f.slot.runId } });
  const bytes = await readFile(f.slot.paths.statePath);
  await filesystem.rename(f.slot.paths.statePath, `${f.slot.paths.statePath}.original`); await writeFile(f.slot.paths.statePath, bytes);
  await expect(restoreManagedTerminal(f.slot.paths, disk)).rejects.toMatchObject({ code: 'SLOT_STATE' });
});

it('rejects corrupt terminal data without upgrading historical command results', async () => {
  const f = await fixture();
  await f.session.execution.run('checksum', { command: 'node', args: ['-e', 'process.exit(0)'] }, 'CHECK_FAILED');
  const disk = await f.slot.store.read(); if (!disk) throw new Error('state fixture missing');
  const terminal = JSON.parse(await readFile(f.terminalPath, 'utf8')); terminal.command.closure.exitCode = 23;
  await writeFile(f.terminalPath, JSON.stringify(terminal));
  await expect(restoreManagedTerminal(f.slot.paths, disk)).rejects.toMatchObject({ code: 'SLOT_STATE', details: { reason: 'TERMINAL_CHECKSUM' } });
});

it('does not apply the previous command terminal to a newer incomplete intent', async () => {
  const f = await fixture();
  await f.session.execution.run('previous-command', { command: 'node', args: ['-e', 'process.exit(0)'] }, 'CHECK_FAILED');
  f.session.state.processes.push({ id: randomUUID(), name: 'incomplete-intent', status: 'intent', observationComplete: false, descendants: [] });
  await f.session.persist();
  const disk = await f.slot.store.read(); if (!disk) throw new Error('state missing');
  const restored = await restoreManagedTerminal(f.slot.paths, disk);
  expect(restored.state.processes.at(-1)).toMatchObject({ name: 'incomplete-intent', status: 'intent', observationComplete: false });
  expect(restored.state.processes.every(hasVerifiedManagedStop)).toBe(false);
  expect(restored.terminal).toBeUndefined();
});

it('keeps a new incomplete run unknown when the exact predecessor terminal is already archived', async () => {
  const f = await managedPhaseSession();
  try {
    await mkdir(f.slot.paths.checkoutRoot);
    await f.session.execution.run('previous-run-command', { command: 'node', args: ['-e', 'process.exit(0)'] }, 'CHECK_FAILED');
    await f.archive(true);
    const terminalPath = resolve(f.slot.paths.slotRoot, 'terminal.json'), terminal = await readFile(terminalPath);
    const session = await f.next('publish', 'f'.repeat(40));
    session.state.processes.push({ id: randomUUID(), name: 'new-incomplete-intent', status: 'intent', observationComplete: false, descendants: [] });
    session.state.status = 'unknown'; await session.persist();
    const stateBytes = await readFile(f.slot.paths.statePath), state = await session.slot.store.read();
    if (!state) throw new Error('current state missing');
    const restored = await restoreManagedTerminal(f.slot.paths, state);
    expect(restored.state).toEqual(state); expect(restored.terminal).toBeUndefined();
    expect(restored.state.processes.every(hasVerifiedManagedStop)).toBe(false);
    expect(await readFile(f.slot.paths.statePath)).toEqual(stateBytes);
    expect(await readFile(terminalPath)).toEqual(terminal);
    const unbound = { ...state, history: [] };
    await session.slot.store.writeState(unbound);
    await expect(restoreManagedTerminal(f.slot.paths, unbound)).rejects.toMatchObject({ code: 'SLOT_STATE', details: { reason: 'TERMINAL_BINDING' } });
    const expectsCurrent = { ...state, processes: state.processes.map(command => ({ ...command, terminalSha256: 'e'.repeat(64) })) };
    await session.slot.store.writeState(expectsCurrent);
    await expect(restoreManagedTerminal(f.slot.paths, expectsCurrent)).rejects.toMatchObject({ code: 'SLOT_STATE', details: { reason: 'TERMINAL_BINDING' } });
    await session.slot.store.writeState(state);
    await filesystem.rename(terminalPath, `${terminalPath}.original`); await writeFile(terminalPath, terminal);
    await expect(restoreManagedTerminal(f.slot.paths, state)).rejects.toMatchObject({ code: 'SLOT_STATE', details: { reason: 'TERMINAL_BINDING' } });
  } finally { await f.dispose(); }
});

it('keeps a running command timeout failed while proving its exact scope is stopped', async () => {
  const f = await fixture();
  commandClock.armed = true;
  const controller = new AbortController(); let started: () => void = () => {}, output = '', settled = false;
  const ready = new Promise<void>(accept => { started = accept; });
  const running = f.session.execution.run('timeout', { command: 'node', args: ['-e',
    'process.stdout.write("terminal-timeout-ready\\n");setInterval(()=>{},100)'], timeoutMs: 5000 }, 'CHECK_FAILED',
  undefined, controller.signal, true, text => { output += text; if (output.includes('terminal-timeout-ready')) started(); });
  const observed = running.then(value => { settled = true; return { value }; }, (error: unknown) => { settled = true; return { error }; });
  try {
  await Promise.race([ready, observed.then(result => {
    if ('error' in result) throw result.error;
    throw new Error('timeout command exited before its payload marker');
  })]);
  const deadline = commandClock.value; if (!deadline) throw new Error('actual command deadline was not captured');
  expect(settled).toBe(false);
  expect(deadline.pendingCount()).toBe(1);
  expect(deadline.interval).toBeGreaterThan(0); expect(deadline.interval).toBeLessThanOrEqual(5000);
  const active = f.session.state.processes.at(-1); if (!active) throw new Error('identified active command required');
  expect(active).toMatchObject({ name: 'timeout', status: 'identified', identity: { pid: expect.any(Number) } });
  expect(hasVerifiedManagedStop(active)).toBe(false);
  deadline.advance(deadline.interval);
  expect(await observed).toMatchObject({ error: { code: 'COMMAND_TIMEOUT' } });
  await expect(f.session.assertClosed()).rejects.toMatchObject({ code: 'PROCESS_STATE_UNKNOWN' });
  await expect(f.session.assertStopped()).resolves.toBeUndefined();
  const command = f.session.state.processes.at(-1); if (!command?.closure?.ownedScope) throw new Error('missing timeout evidence');
  expect(command).toMatchObject({ status: 'stopped', closure: { requestedTermination: 'timeout', ownedScope: { empty: true, reason: 'terminated' } } });
  for (const reason of ['owner-lost', 'provider-failed', 'descendants-remained'] as const) {
    expect(hasVerifiedManagedStop({ ...command, closure: { ...command.closure, ownedScope: { ...command.closure.ownedScope, status: 'unknown', reason } } })).toBe(false);
  }
  expect(hasVerifiedManagedStop({ ...command, scope: { scopeId: randomUUID(), binding: command.scope?.binding ?? '' } })).toBe(false);
  } finally { controller.abort(); await observed; commandClock.value?.dispose(); commandClock.value = undefined; commandClock.armed = false; }
});

it('records the stopped scope independently of invalid checkout Git metadata', async () => {
  const f = await fixture();
  await expect(f.session.execution.run('broken-checkout-git', { command: 'node', args: ['-e',
    'const fs=require("node:fs");fs.mkdirSync(".git");fs.writeFileSync(".git/commondir",process.argv[1]);process.exit(23)', f.root] }, 'CHECK_FAILED'))
    .rejects.toMatchObject({ code: 'SLOT_PATH' });
  expect(JSON.parse(await readFile(f.terminalPath, 'utf8'))).toMatchObject({ command: { observationComplete: true, closure: { ownedScope: { empty: true } } } });
  await expect(f.session.assertStopped()).rejects.toMatchObject({ code: 'SLOT_PATH' });
});

it('preserves the first atomic write error and removes only its own intact temporary file', async () => {
  const f = await fixture(), original = await readFile(f.slot.paths.statePath, 'utf8'), rename = filesystem.rename;
  const spy = vi.spyOn(filesystem, 'rename').mockImplementation(async (from, to) => {
    if (to === f.slot.paths.statePath) throw Object.assign(new Error('fixture rename failure'), { code: 'EPERM' });
    await rename(from, to);
  });
  await expect(f.session.persist()).rejects.toMatchObject({ code: 'EPERM' });
  expect(await readFile(f.slot.paths.statePath, 'utf8')).toBe(original);
  await expect(readFile(resolve(f.slot.paths.slotRoot, '.state.json.next'))).rejects.toMatchObject({ code: 'ENOENT' });
  spy.mockRestore();
  await f.session.persist();
});
