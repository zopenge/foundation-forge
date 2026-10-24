import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import type { ReadProcessIdentityResult } from '@openge/forge-process-control';
import { identityReader, processControl } from '../src/node/process-identities.js';
import { closeFixtureIdentity } from './helpers/close-fixture-process.js';

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
