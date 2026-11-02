import { expect, test, vi } from 'vitest';
import { ProcessControlError, processControlErrorCodes, type ProcessIdentityReader, type ReadProcessIdentityResult } from '@openge/forge-process-control';
import { createWindowsProcessControl, type ProcessCommandRunner } from '../src/index.js';

const identity = { pid: 42, startToken: '/Date(123)/' };
const found: ReadProcessIdentityResult = { status: 'FOUND', identity };
const transport = () => vi.fn<ProcessCommandRunner>().mockImplementation(async request => {
  if (request.command !== 'taskkill.exe') throw new Error('command identity transport is unavailable');
  return { exitCode: 0, stdout: 'SUCCESS', stderr: '' };
});

test.each(['terminateProcess', 'terminateProcessTree'] as const)('%s uses an explicitly supplied reader without invoking a command identity backend', async method => {
  const readIdentity = vi.fn<ProcessIdentityReader['readIdentity']>().mockResolvedValue(found);
  const runner = transport(), signal = new AbortController().signal;
  const provider = createWindowsProcessControl({ listenerBackend: 'netstat', runner, identityReader: { readIdentity } });
  await expect(provider[method]({ process: identity, policy: { mode: 'force' }, signal }))
    .resolves.toEqual({ pid: identity.pid, forced: true });
  expect(readIdentity).toHaveBeenCalledExactlyOnceWith({ pid: identity.pid, signal });
  expect(runner).toHaveBeenCalledExactlyOnceWith({ command: 'taskkill.exe', signal,
    args: ['/PID', '42', ...(method === 'terminateProcessTree' ? ['/T'] : []), '/F'] });
});

test.each([
  { value: { status: 'ABSENT' } as const, code: processControlErrorCodes.processIdentityUnavailable },
  { value: { status: 'FOUND', identity: { ...identity, pid: 43 } } as const, code: processControlErrorCodes.processIdentityUnavailable },
  { value: { status: 'FOUND', identity: { ...identity, startToken: '' } } as const, code: processControlErrorCodes.processIdentityUnavailable },
  { value: { status: 'FOUND', identity: { ...identity, startToken: '/Date(124)/' } } as const, code: processControlErrorCodes.processIdentityChanged },
])('rejects an unusable injected observation before termination: $code/$value.status', async ({ value, code }) => {
  const runner = transport();
  const provider = createWindowsProcessControl({ listenerBackend: 'netstat', runner,
    identityReader: { readIdentity: async () => value } });
  await expect(provider.terminateProcessTree({ process: identity, policy: { mode: 'force' } })).rejects.toMatchObject({ code });
  expect(runner).not.toHaveBeenCalled();
});

test.each(['structured', 'unknown', 'cancelled'] as const)('does not fall back after injected reader %s', async mode => {
  const runner = transport(), controller = new AbortController();
  const original = new ProcessControlError(processControlErrorCodes.unsupportedBackend, { stage: 'fixture' });
  const readIdentity = vi.fn<ProcessIdentityReader['readIdentity']>().mockImplementation(async () => {
    if (mode === 'structured') throw original;
    if (mode === 'unknown') throw new Error('private fixture details');
    controller.abort(); return found;
  });
  const provider = createWindowsProcessControl({ listenerBackend: 'netstat', runner, identityReader: { readIdentity } });
  const result = provider.terminateProcessTree({ process: identity, policy: { mode: 'force' }, signal: controller.signal });
  if (mode === 'structured') await expect(result).rejects.toBe(original);
  else await expect(result).rejects.toMatchObject({ code: mode === 'cancelled' ? processControlErrorCodes.operationAborted : processControlErrorCodes.commandFailed });
  expect(readIdentity).toHaveBeenCalledTimes(1); expect(runner).not.toHaveBeenCalled();
});

test('reads again before escalation and never caches a previous termination identity', async () => {
  const readIdentity = vi.fn<ProcessIdentityReader['readIdentity']>().mockResolvedValueOnce(found)
    .mockResolvedValue({ status: 'FOUND', identity: { ...identity, startToken: '/Date(124)/' } });
  const runner = transport();
  const provider = createWindowsProcessControl({ listenerBackend: 'netstat', runner, identityReader: { readIdentity } });
  await expect(provider.terminateProcessTree({ process: identity,
    policy: { mode: 'graceful-then-force', gracePeriodMs: 0, pollIntervalMs: 1 } }))
    .rejects.toMatchObject({ code: processControlErrorCodes.processIdentityChanged });
  expect(readIdentity).toHaveBeenCalledTimes(2);
  expect(runner).toHaveBeenCalledExactlyOnceWith({ command: 'taskkill.exe', args: ['/PID', '42', '/T'] });
  await expect(provider.terminateProcess({ process: identity, policy: { mode: 'force' } }))
    .rejects.toMatchObject({ code: processControlErrorCodes.processIdentityChanged });
  expect(readIdentity).toHaveBeenCalledTimes(3); expect(runner).toHaveBeenCalledTimes(1);
});
