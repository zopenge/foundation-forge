import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createManagedSession } from '../src/node/managed-process.js';
import { freezeManagedSource } from '../src/node/source.js';
import { openManagedSlot } from '../src/node/managed-paths.js';
import { managedFixture } from './helpers/managed-fixture.js';
import { currentCoordinator, identityReader } from '../src/node/process-identities.js';
import { closeFixtureIdentity } from './helpers/close-fixture-process.js';
import type { ManagedSession } from '../src/node/release-context.js';
import { inspectManagedRecovery } from '../src/node/managed-recovery.js';

const fixtures: Awaited<ReturnType<typeof managedFixture>>[] = [];
const sessions: ManagedSession[] = [];
async function closeFastFixtureChild(marker: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const pid = Number(await readFile(marker, 'utf8')), current = await identityReader().readIdentity({ pid, signal: AbortSignal.timeout(10_000) });
      if (current.status === 'FOUND') await closeFixtureIdentity(current.identity, { signal: AbortSignal.timeout(10_000) });
      return;
    } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; await new Promise(accept => setTimeout(accept, 100)); }
  }
}
it('cancels coordinator identity acquisition before doing native process work', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(currentCoordinator(controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
});
afterEach(async () => {
  for (const session of sessions.splice(0)) for (const command of session.state.processes) {
    for (const identity of [...command.descendants, ...(command.identity ? [command.identity] : [])]) {
      const observed = await identityReader().readIdentity({ pid: identity.pid });
      if (observed.status === 'FOUND' && observed.identity.startToken === identity.startToken) await closeFixtureIdentity(identity);
    }
  }
  for (const f of fixtures.splice(0)) await f.dispose();
});
const fixture = async () => {
  const f = await managedFixture(); fixtures.push(f);
  const source = await freezeManagedSource(f.cwd, 'release.config.json', f.execution);
  const slot = await openManagedSlot(source, f.execution);
  await mkdir(slot.paths.checkoutRoot);
  const session = await createManagedSession(slot, 'check'); sessions.push(session);
  return { ...f, slot, session };
};
it('journals identity before a short real command runs and proves foreground closure', async () => {
  const f = await fixture();
  const output = await f.session.execution.run('short-command', { command: 'node', args: ['-e', 'const c=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).processes[0];if(c.status!=="identified"||!c.scope||!c.identity)process.exit(55);process.stdout.write("done")', f.slot.paths.statePath] }, 'CHECK_FAILED');
  expect(output).toBe('done'); await f.session.assertClosed();
  const state = await f.slot.store.read();
  expect(state?.processes).toHaveLength(1); expect(state?.processes[0]).toMatchObject({ status: 'closed', observationComplete: true });
  expect(state?.processes[0]?.identity?.startToken).toBeTruthy();
  expect(f.session.budget.summary().sampleCount).toBeGreaterThanOrEqual(2);
  await f.slot.lock.release();
});
it('protects operation metadata from inherited environment values', async () => {
  const inherited = process.env.FORGE_RELEASE_COMMAND; process.env.FORGE_RELEASE_COMMAND = 'publish';
  try {
    const f = await fixture();
    const output = await f.session.execution.run('metadata', { command: 'node', args: ['-e', 'process.stdout.write(JSON.stringify([process.env.FORGE_RELEASE_COMMAND,process.env.FORGE_RELEASE_SHA]))'] }, 'CHECK_FAILED');
    expect(JSON.parse(output)).toEqual(['check', f.sha]); await f.session.assertClosed(); await f.slot.lock.release();
  } finally { if (inherited === undefined) delete process.env.FORGE_RELEASE_COMMAND; else process.env.FORGE_RELEASE_COMMAND = inherited; }
});
it('does not execute a job when its lock was replaced before launch', async () => {
  const f = await fixture(); const marker = resolve(f.slot.paths.slotRoot, 'should-not-exist');
  await writeFile(f.slot.paths.lockPath, 'replacement');
  await expect(f.session.execution.run('blocked', { command: 'node', args: ['-e', 'require("node:fs").writeFileSync(process.argv[1],"bad")', marker] }, 'CHECK_FAILED')).rejects.toMatchObject({ code: 'LOCK_OWNERSHIP' });
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
});
it.each(['journal-failure', 'lock-replaced'])('never authorizes the real job after scope-ready with %s', async mode => {
  const f = await fixture(), marker = resolve(f.slot.paths.slotRoot, 'forbidden-after-ready');
  const write = f.slot.store.writeState.bind(f.slot.store);
  vi.spyOn(f.slot.store, 'writeState').mockImplementation(async (state, beforeCommit) => {
    if (state.processes.some(command => command.status === 'identified')) {
      if (mode === 'journal-failure') throw Error('fixture journal unavailable');
      await write(state, beforeCommit); await writeFile(f.slot.paths.lockPath, 'replacement'); return;
    }
    await write(state, beforeCommit);
  });
  await expect(f.session.execution.run('never-authorized', { command: 'node', args: ['-e', 'require("node:fs").writeFileSync(process.argv[1],"bad")', marker] }, 'CHECK_FAILED')).rejects.toThrow();
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  if (mode === 'journal-failure') {
    expect(f.session.state.processes[0]?.status).toBe('stopped');
    expect(JSON.parse(await readFile(resolve(f.slot.paths.slotRoot, 'terminal.json'), 'utf8'))).toMatchObject({ command: {
      observationComplete: true, closure: { requestedTermination: 'abort', ownedScope: { reason: 'terminated', empty: true } },
    } });
  } else expect(f.session.state.processes[0]?.status).toBe('unknown');
});
it.each(['EBUSY', 'SECRETCODE'])('preserves only known lifecycle failure codes without exposing messages: %s', async code => {
  const f = await fixture(), write = f.slot.store.writeState.bind(f.slot.store);
  vi.spyOn(f.slot.store, 'writeState').mockImplementation(async (state, beforeCommit) => {
    if (state.processes.some(command => command.status === 'closed')) throw Object.assign(new Error('token=fixture-private'), { code });
    await write(state, beforeCommit);
  });
  const observed = await f.session.execution.run('journal-code', { command: 'node', args: ['-e', 'process.stdout.write("done")'] }, 'CHECK_FAILED')
    .then(value => ({ value }), (error: unknown) => ({ error }));
  expect(observed).toMatchObject({ error: { code: 'PROCESS_STATE_UNKNOWN', details: { reason: 'PROCESS_LIFECYCLE_FAILED', ...(code === 'EBUSY' ? { causeCode: code } : {}) } } });
  expect(JSON.stringify(observed)).not.toContain('fixture-private');
  if (code !== 'EBUSY') expect(JSON.stringify(observed)).not.toContain(code);
  expect(f.session.state.processes[0]?.status).toBe('closed');
  const terminal = await readFile(resolve(f.slot.paths.slotRoot, 'terminal.json'), 'utf8');
  expect(JSON.parse(terminal)).toMatchObject({ command: { status: 'closed', closure: { ownedScope: { status: 'closed', empty: true } } } });
  expect(terminal).not.toContain('fixture-private');
});
it('keeps the queued first failure when a retained atomic file blocks later journal writes', async () => {
  const f = await fixture(), write = f.slot.store.writeState.bind(f.slot.store);
  let failed = false;
  vi.spyOn(f.slot.store, 'writeState').mockImplementation(async (state, beforeCommit) => {
    if (!failed && state.processes.some(command => command.status === 'identified')) {
      failed = true;
      await writeFile(resolve(f.slot.paths.slotRoot, '.state.json.next'), 'retained first failure');
      throw Object.assign(new Error('private first failure'), { code: 'EBUSY' });
    }
    await write(state, beforeCommit);
  });
  const marker = resolve(f.slot.paths.slotRoot, 'must-not-run');
  await expect(f.session.execution.run('first-failure', { command: 'node', args: ['-e', 'require("node:fs").writeFileSync(process.argv[1],"bad")', marker] }, 'CHECK_FAILED'))
    .rejects.toMatchObject({ code: 'PROCESS_STATE_UNKNOWN', details: { reason: 'JOURNAL_FAILED', causeCode: 'EBUSY' } });
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(resolve(f.slot.paths.slotRoot, '.state.json.next'), 'utf8')).toBe('retained first failure');
});
it('does not treat an exited parent as proof that its writer child closed', async () => {
  const f = await fixture(), path = resolve(f.slot.paths.slotRoot, 'child-writes');
  const writer = 'setInterval(()=>require("node:fs").appendFileSync(process.argv[1],"x"),100)';
  const parent = `const child=require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(writer)},process.argv[1]],{stdio:"ignore",detached:true,windowsHide:true});child.unref();setTimeout(()=>process.exit(0),2500)`;
  const result = await f.session.execution.run('parent-child', { command: 'node', args: ['-e', parent, path] }, 'CHECK_FAILED').then(value => ({ value }), (error: unknown) => ({ error }));
  expect(result, JSON.stringify(f.session.state.processes)).toMatchObject({ error: { code: 'PROCESS_STATE_UNKNOWN' } });
  expect(f.session.state.processes[0]?.closure?.ownedScope).toMatchObject({ status: 'unknown', reason: 'descendants-remained', empty: true });
  const size = (await readFile(path)).length; await new Promise(accept => setTimeout(accept, 300));
  expect((await readFile(path)).length).toBe(size);
  await expect(f.session.assertClosed()).rejects.toMatchObject({ code: 'PROCESS_STATE_UNKNOWN' });
  expect(await readFile(f.slot.paths.lockPath, 'utf8')).toContain(f.slot.runId);
});
it('keeps cancellation failed while distinguishing safe stopping from normal closure', async () => {
  const f = await fixture(), path = resolve(f.slot.paths.slotRoot, 'cancel-writes');
  const controller = new AbortController();
  const pending = f.session.execution.run('cancelled', { command: 'node', args: ['-e', 'setInterval(()=>require("node:fs").appendFileSync(process.argv[1],"x"),100)', path] }, 'CHECK_FAILED', undefined, controller.signal);
  const failure = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  try { for (let i = 0; i < 60; i++) { try { await readFile(path); break; } catch { await new Promise(accept => setTimeout(accept, 100)); } } }
  finally { controller.abort(); }
  await failure; const size = (await readFile(path)).length;
  await new Promise(accept => setTimeout(accept, 250)); expect((await readFile(path)).length).toBe(size);
  expect(f.session.state.processes[0]?.status).toBe('stopped');
  await expect(f.session.assertClosed()).rejects.toMatchObject({ code: 'PROCESS_STATE_UNKNOWN' });
  await expect(f.session.assertStopped()).resolves.toBeUndefined();
});
it('fails closed when a recorded running identity changes', async () => {
  const f = await fixture(), path = resolve(f.slot.paths.slotRoot, 'identity-started');
  const pending = f.session.execution.run('identity-change', { command: 'node', args: ['-e', 'require("node:fs").writeFileSync(process.argv[1],"started");setTimeout(()=>{},2500)', path] }, 'CHECK_FAILED');
  const result = pending.then(value => ({ value }), (error: unknown) => ({ error }));
  for (let i = 0; i < 60; i++) { try { await readFile(path); break; } catch { await new Promise(accept => setTimeout(accept, 100)); } }
  const command = f.session.state.processes[0];
  if (!command?.identity) throw new Error('fixture did not acquire identity');
  command.identity = { ...command.identity, startToken: 'changed-recorded-identity' };
  const observed = await result;
  expect(observed, JSON.stringify(observed)).toMatchObject({ error: { code: 'PROCESS_STATE_UNKNOWN' } });
});
it('reuses a completed command closure witness while still observing the current owner', async () => {
  const f = await fixture();
  await f.session.execution.run('closed-proof', { command: 'node', args: ['-e', 'process.stdout.write("closed")'] }, 'CHECK_FAILED');
  let reads = 0; const native = identityReader();
  const observed = await inspectManagedRecovery(f.session.state, f.slot.paths, undefined, { readIdentity: async request => {
    reads++;
    if (request.pid !== f.session.state.coordinator.pid) throw new Error('completed process witness was probed again');
    return native.readIdentity(request);
  } });
  expect(observed).toMatchObject({ owner: 'active', processes: 'closed' }); expect(reads).toBe(1); await f.slot.lock.release();
});
it('does not claim closure for a detached writer whose parent exits immediately', async () => {
  const f = await fixture(), marker = resolve(f.slot.paths.slotRoot, 'fast-child-pid'), output = resolve(f.slot.paths.slotRoot, 'fast-child-writes');
  const writer = 'const fs=require("node:fs");fs.writeFileSync(process.argv[1],String(process.pid));setInterval(()=>fs.appendFileSync(process.argv[2],"x"),50)';
  const parent = `const child=require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(writer)},process.argv[1],process.argv[2]],{stdio:"ignore",detached:true,windowsHide:true});child.unref();`;
  try {
    const result = await f.session.execution.run('fast-detached-child', { command: 'node', args: ['-e', parent, marker, output] }, 'CHECK_FAILED').then(value => ({ value }), (error: unknown) => ({ error }));
    expect(result).toMatchObject({ error: { code: 'PROCESS_STATE_UNKNOWN' } });
    await expect(f.session.assertClosed()).rejects.toMatchObject({ code: 'PROCESS_STATE_UNKNOWN' });
    expect(await readFile(f.slot.paths.lockPath, 'utf8')).toContain(f.slot.runId);
  } finally { await closeFastFixtureChild(marker); }
});
