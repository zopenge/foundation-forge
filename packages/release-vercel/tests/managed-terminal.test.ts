import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createManagedSession } from '../src/node/managed-process.js';
import { committedFixtureSource } from './helpers/committed-fixture-source.js';
import { openManagedSlot } from '../src/node/managed-paths.js';
import { managedFixture } from './helpers/managed-fixture.js';
import { identityReader } from '../src/node/process-identities.js';
import { closeFixtureIdentity } from './helpers/close-fixture-process.js';
import type { ManagedSession } from '../src/node/release-context.js';
import * as retirementHost from '../src/node/retirement-host.js';
import { restoreManagedTerminal } from '../src/node/managed-terminal.js';
import { randomUUID } from 'node:crypto';
import { hasVerifiedManagedStop } from '../src/node/managed-closure.js';

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof filesystem>() }));

const fixtures: Awaited<ReturnType<typeof managedFixture>>[] = [];
const sessions: ManagedSession[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const session of sessions.splice(0)) for (const command of session.state.processes) {
    if (!command.identity) continue;
    const found = await identityReader().readIdentity({ pid: command.identity.pid });
    if (found.status === 'FOUND' && found.identity.startToken === command.identity.startToken) await closeFixtureIdentity(command.identity);
  }
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});
async function fixture() {
  const f = await managedFixture(); fixtures.push(f);
  if (f.config.source.mode !== 'managed-commit') throw new Error('managed fixture required');
  Object.assign(f.config.source, { sampleIntervalMs: 5000 });
  await writeFile(resolve(f.cwd, 'release.config.json'), JSON.stringify(f.config)); const sha = f.commit();
  const source = await committedFixtureSource(f, sha);
  const slot = await openManagedSlot(source, f.execution); await mkdir(slot.paths.checkoutRoot);
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

it('keeps a real timeout failed while proving its exact scope is stopped', async () => {
  const f = await fixture();
  await expect(f.session.execution.run('timeout', { command: 'node', args: ['-e', 'setInterval(()=>{},100)'], timeoutMs: 5000 }, 'CHECK_FAILED'))
    .rejects.toMatchObject({ code: 'COMMAND_TIMEOUT' });
  await expect(f.session.assertClosed()).rejects.toMatchObject({ code: 'PROCESS_STATE_UNKNOWN' });
  await expect(f.session.assertStopped()).resolves.toBeUndefined();
  const command = f.session.state.processes.at(-1); if (!command?.closure?.ownedScope) throw new Error('missing timeout evidence');
  expect(command).toMatchObject({ status: 'stopped', closure: { requestedTermination: 'timeout', ownedScope: { empty: true, reason: 'terminated' } } });
  for (const reason of ['owner-lost', 'provider-failed', 'descendants-remained'] as const) {
    expect(hasVerifiedManagedStop({ ...command, closure: { ...command.closure, ownedScope: { ...command.closure.ownedScope, status: 'unknown', reason } } })).toBe(false);
  }
  expect(hasVerifiedManagedStop({ ...command, scope: { scopeId: randomUUID(), binding: command.scope?.binding ?? '' } })).toBe(false);
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
