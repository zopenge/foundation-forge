import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import type { ProcessDescriptor, ReadProcessIdentityResult } from '@openge/forge-process-control';
import { identityReader, processControl } from '../src/node/process-identities.js';
import { captureFixtureAncestry, closeFixtureIdentity } from './helpers/close-fixture-process.js';

it('confirms absence when a real fixture exits between observation and termination', async () => {
  const child = spawn(process.execPath, ['--input-type=commonjs', '-e',
    'process.on("message",()=>process.exit(0));process.send("ready");'],
  { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  const closed = new Promise<void>(accept => child.once('close', () => accept()));
  try {
    await once(child, 'message', { signal: AbortSignal.timeout(10_000) });
    if (child.pid === undefined) throw new Error('fixture did not start');
    const reader = identityReader(), control = processControl();
    const observed = await reader.readIdentity({ pid: child.pid, signal: AbortSignal.timeout(10_000) });
    expect(observed.status).toBe('FOUND');
    if (observed.status !== 'FOUND') throw new Error('fixture identity was not captured');
    let raced = false;
    await expect(closeFixtureIdentity(observed.identity, { reader, signal: AbortSignal.timeout(10_000),
      control: { terminateProcessTree: async request => {
        child.send('exit');
        await closed;
        expect(await reader.readIdentity({ pid: observed.identity.pid })).toEqual({ status: 'ABSENT' });
        try { return await control.terminateProcessTree(request); }
        catch (error) {
          expect(error).toMatchObject({ code: 'PROCESS_IDENTITY_UNAVAILABLE' });
          raced = true;
          throw error;
        }
      } },
    })).resolves.toBeUndefined();
    expect(raced).toBe(true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  }
});

const identity = { pid: 123, startToken: 'fixture-start' };
const unavailable = () => Object.assign(new Error('fixture identity disappeared'), { code: 'PROCESS_IDENTITY_UNAVAILABLE' });

it('requires a fresh absence observation after the specific identity race', async () => {
  const readIdentity = vi.fn(async (): Promise<ReadProcessIdentityResult> => ({ status: 'ABSENT' }));
  const terminateProcessTree = vi.fn(async () => { throw unavailable(); });
  await expect(closeFixtureIdentity(identity, { reader: { readIdentity }, control: { terminateProcessTree } })).resolves.toBeUndefined();
  expect(readIdentity).toHaveBeenCalledExactlyOnceWith({ pid: identity.pid });
  expect(terminateProcessTree).toHaveBeenCalledTimes(1);
});

it.each(['fixture-start', 'replacement'])('does not accept a found identity after termination fails: %s', async startToken => {
  const error = unavailable();
  const readIdentity = vi.fn(async (): Promise<ReadProcessIdentityResult> => ({ status: 'FOUND', identity: { pid: identity.pid, startToken } }));
  const terminateProcessTree = vi.fn(async () => { throw error; });
  await expect(closeFixtureIdentity(identity, { reader: { readIdentity }, control: { terminateProcessTree } })).rejects.toBe(error);
  expect(terminateProcessTree).toHaveBeenCalledTimes(1);
});

it('propagates an unavailable follow-up observation instead of assuming absence', async () => {
  const observationError = new Error('fixture observation failed');
  await expect(closeFixtureIdentity(identity, {
    reader: { readIdentity: async () => { throw observationError; } },
    control: { terminateProcessTree: async () => { throw unavailable(); } },
  })).rejects.toBe(observationError);
});

it.each(['PROCESS_IDENTITY_CHANGED', 'COMMAND_FAILED', 'OPERATION_ABORTED'])('does not suppress a different termination error: %s', async code => {
  const error = Object.assign(new Error('fixture termination failed'), { code });
  const readIdentity = vi.fn(async (): Promise<ReadProcessIdentityResult> => ({ status: 'ABSENT' }));
  await expect(closeFixtureIdentity(identity, { reader: { readIdentity },
    control: { terminateProcessTree: async () => { throw error; } },
  })).rejects.toBe(error);
  expect(readIdentity).not.toHaveBeenCalled();
});

const owner = { pid: 10, startToken: 'owner' };
const ancestry = (): Record<number, ProcessDescriptor> => ({
  10: owner, 20: { pid: 20, startToken: 'parent', parentPid: 10 },
  30: { pid: 30, startToken: 'leaf', parentPid: 20, commandLine: 'private fixture argv' },
});

it('captures only an identity-bound fixture ancestry using exact PID requests', async () => {
  expect(captureFixtureAncestry).toBeTypeOf('function');
  const rows = ancestry(), listProcesses = vi.fn(async ({ pids }: { pids?: readonly number[] }) => {
    expect(pids?.length).toBeGreaterThan(0);
    return (pids ?? []).flatMap(pid => rows[pid] ? [{ ...rows[pid] }] : []);
  });
  expect(await captureFixtureAncestry(owner, 30, { control: { listProcesses } })).toEqual([
    { pid: 30, startToken: 'leaf' }, { pid: 20, startToken: 'parent' },
  ]);
  expect(new Set(listProcesses.mock.calls.map(([request]) => request.pids?.[0]))).toEqual(new Set([10, 20, 30]));
  expect(listProcesses.mock.calls.length).toBeLessThanOrEqual(3);
});

it.each(['owner-replaced', 'leaf-absent', 'unrelated', 'cycle', 'identity-changed', 'parent-changed'] as const)('rejects an unbound fixture ancestry: %s', async mode => {
  const rows = ancestry(); let leafReads = 0;
  if (mode === 'owner-replaced') rows[10] = { ...owner, startToken: 'replacement' };
  if (mode === 'leaf-absent') delete rows[30];
  if (mode === 'unrelated') rows[20] = { pid: 20, startToken: 'parent', parentPid: 40 };
  if (mode === 'cycle') rows[20] = { pid: 20, startToken: 'parent', parentPid: 30 };
  const listProcesses = vi.fn(async ({ pids }: { pids?: readonly number[] }) => {
    expect(pids?.length).toBeGreaterThan(0);
    return (pids ?? []).flatMap(pid => {
      const row = rows[pid]; if (!row) return [];
      if (pid === 30 && ++leafReads > 1) {
        if (mode === 'identity-changed') return [{ ...row, startToken: 'replacement' }];
        if (mode === 'parent-changed') return [{ ...row, parentPid: 40 }];
      }
      return [{ ...row }];
    });
  });
  await expect(captureFixtureAncestry(owner, 30, { control: { listProcesses } })).rejects.toThrow('FIXTURE_ANCESTRY');
  expect(listProcesses.mock.calls.length).toBeLessThan(10);
});
