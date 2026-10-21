import { expect, test, vi } from 'vitest';
import { resolve } from 'node:path';

import { ProcessControlError, processControlErrorCodes } from '@openge/forge-process-control';

import {
  createPosixProcessIdentityReader,
  createWindowsProcessIdentityReader,
  type ProcessCommandRunner,
} from '../src/index.js';

const windowsToken = '20260903070000.000000+480';
const posixToken = 'Thu Sep  3 07:00:00 2026';
const platforms = [
  {
    command: 'powershell.exe',
    create: createWindowsProcessIdentityReader,
    name: 'Windows',
    startToken: windowsToken,
    stdout: JSON.stringify({ CreationDate: windowsToken, ProcessId: 42 }),
  },
  {
    command: 'ps',
    create: createPosixProcessIdentityReader,
    name: 'Posix',
    startToken: posixToken,
    stdout: ` 42 ${posixToken}\n`,
  },
] as const;

for (const platform of platforms) {
  test(`${platform.name} reader returns only the requested PID and start token`, async () => {
    const runner = vi.fn<ProcessCommandRunner>().mockResolvedValue({
      exitCode: 0, stderr: '', stdout: platform.stdout,
    });
    const reader = platform.create({ runner });
    const signal = new AbortController().signal;

    await expect(reader.readIdentity({ pid: 42, signal })).resolves.toEqual({
      identity: { pid: 42, startToken: platform.startToken }, status: 'FOUND',
    });
    expect(Object.keys(reader)).toEqual(['readIdentity']);
    expect(runner).toHaveBeenCalledExactlyOnceWith({
      args: platform.name === 'Windows'
        ? [
          '-NoProfile', '-NonInteractive', '-Command',
          "$observed = $null; try { try { $observed = [System.Diagnostics.Process]::GetProcessById(42) } catch [System.ArgumentException] { exit 0 }; [long]$remainder = 0; $milliseconds = [System.Math]::DivRem(($observed.StartTime.ToUniversalTime().Ticks - 621355968000000000L),10000L,[ref]$remainder); [Console]::WriteLine('{\"ProcessId\":'+$observed.Id.ToString([System.Globalization.CultureInfo]::InvariantCulture)+',\"CreationDate\":\"/Date('+$milliseconds.ToString([System.Globalization.CultureInfo]::InvariantCulture)+')/\"}'); } finally { if ($null -ne $observed) { $observed.Dispose() } }",
        ]
        : ['-o', 'pid=', '-o', 'lstart=', '-p', '42'],
      command: platform.command,
      signal,
    });
  });

  test.each(['', ' \r\n '])(`${platform.name} reader confirms absence for empty successful output %j`, async (stdout) => {
    const runner = vi.fn<ProcessCommandRunner>().mockResolvedValue({ exitCode: 0, stderr: '', stdout });

    await expect(platform.create({ runner }).readIdentity({ pid: 42 })).resolves.toEqual({ status: 'ABSENT' });
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    `${platform.name} reader rejects invalid PID %j before transport`, async (pid) => {
      const runner = vi.fn<ProcessCommandRunner>();

      await expect(platform.create({ runner }).readIdentity({ pid })).rejects.toMatchObject({
        code: processControlErrorCodes.invalidInput,
      });
      expect(runner).not.toHaveBeenCalled();
    },
  );

  test(`${platform.name} reader rejects an already aborted request before transport`, async () => {
    const runner = vi.fn<ProcessCommandRunner>();

    await expect(platform.create({ runner }).readIdentity({
      pid: 42, signal: AbortSignal.abort(),
    })).rejects.toMatchObject({ code: processControlErrorCodes.operationAborted });
    expect(runner).not.toHaveBeenCalled();
  });

  test(`${platform.name} reader rejects a request aborted during transport`, async () => {
    const controller = new AbortController();
    const runner: ProcessCommandRunner = async () => {
      controller.abort();
      return { exitCode: 0, stderr: '', stdout: platform.stdout };
    };

    await expect(platform.create({ runner }).readIdentity({
      pid: 42, signal: controller.signal,
    })).rejects.toMatchObject({ code: processControlErrorCodes.operationAborted });
  });

  test.each([0, 1])(`${platform.name} reader rejects permission diagnostics at exit code %i without retry`, async (exitCode) => {
    const runner = vi.fn<ProcessCommandRunner>().mockResolvedValue({
      exitCode, stderr: 'PermissionDenied HRESULT 0x80041003', stdout: '',
    });

    await expect(platform.create({ runner }).readIdentity({ pid: 42 })).rejects.toMatchObject({
      code: processControlErrorCodes.commandFailed,
      details: { command: platform.command, exitCode, stderr: 'PermissionDenied HRESULT 0x80041003' },
    });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  test(`${platform.name} reader rejects failed transport even without diagnostic output`, async () => {
    const runner: ProcessCommandRunner = async () => ({ exitCode: 2, stderr: '', stdout: '' });

    await expect(platform.create({ runner }).readIdentity({ pid: 42 })).rejects.toMatchObject({
      code: processControlErrorCodes.commandFailed,
    });
  });

  test(`${platform.name} reader wraps unstructured transport failures`, async () => {
    const cause = new Error('transport unavailable');
    const runner = vi.fn<ProcessCommandRunner>().mockRejectedValue(cause);

    await expect(platform.create({ runner }).readIdentity({ pid: 42 })).rejects.toMatchObject({
      cause, code: processControlErrorCodes.commandFailed,
    });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  test(`${platform.name} reader preserves structured transport failures`, async () => {
    const error = new ProcessControlError(processControlErrorCodes.unsupportedBackend);
    const runner = vi.fn<ProcessCommandRunner>().mockRejectedValue(error);

    await expect(platform.create({ runner }).readIdentity({ pid: 42 })).rejects.toBe(error);
  });
}

test('Windows reader confirms an empty result array as absence', async () => {
  const runner: ProcessCommandRunner = async () => ({ exitCode: 0, stderr: '', stdout: '[]' });

  await expect(createWindowsProcessIdentityReader({ runner }).readIdentity({ pid: 42 }))
    .resolves.toEqual({ status: 'ABSENT' });
});

test('Windows reader strips descriptive fields returned by an injected transport', async () => {
  const runner: ProcessCommandRunner = async () => ({
    exitCode: 0,
    stderr: '',
    stdout: JSON.stringify([{
      CommandLine: 'private arguments', CreationDate: windowsToken,
      ExecutablePath: 'private path', Name: 'node.exe', ProcessId: 42,
    }]),
  });

  await expect(createWindowsProcessIdentityReader({ runner }).readIdentity({ pid: 42 }))
    .resolves.toEqual({ identity: { pid: 42, startToken: windowsToken }, status: 'FOUND' });
});

test.each([
  null, 42, 'unavailable', [null], {},
  { CreationDate: windowsToken, ProcessId: 43 },
  { ProcessId: 42 },
  { CreationDate: null, ProcessId: 42 },
  { CreationDate: 123, ProcessId: 42 },
  { CreationDate: '', ProcessId: 42 },
  { CreationDate: '   ', ProcessId: 42 },
  [{ CreationDate: windowsToken, ProcessId: 42 }, null],
  [{ CreationDate: windowsToken, ProcessId: 42 }, { CreationDate: windowsToken, ProcessId: 42 }],
])('Windows reader rejects ambiguous or invalid identity output %j', async (value) => {
  const runner: ProcessCommandRunner = async () => ({ exitCode: 0, stderr: '', stdout: JSON.stringify(value) });

  await expect(createWindowsProcessIdentityReader({ runner }).readIdentity({ pid: 42 }))
    .rejects.toMatchObject({ code: processControlErrorCodes.processIdentityUnavailable });
});

test('Windows reader rejects malformed JSON as a structured command error', async () => {
  const runner: ProcessCommandRunner = async () => ({ exitCode: 0, stderr: '', stdout: '{' });

  await expect(createWindowsProcessIdentityReader({ runner }).readIdentity({ pid: 42 }))
    .rejects.toMatchObject({ code: processControlErrorCodes.commandFailed });
});

test('Posix reader confirms the ps no-match exit status as absence', async () => {
  const runner: ProcessCommandRunner = async () => ({ exitCode: 1, stderr: '', stdout: '' });

  await expect(createPosixProcessIdentityReader({ runner }).readIdentity({ pid: 42 }))
    .resolves.toEqual({ status: 'ABSENT' });
});

test('Posix reader rejects a native command launch failure instead of reporting absence', async () => {
  const { runProcessCommand } = await import('../src/command-runner.js');
  const reader = createPosixProcessIdentityReader({
    runner: request => runProcessCommand({
      ...request,
      command: resolve('.tmp', 'identity-reader-command-does-not-exist'),
    }),
  });
  await expect(reader.readIdentity({ pid: process.pid })).rejects.toMatchObject({
    code: processControlErrorCodes.commandFailed,
    cause: { code: 'ENOENT' },
  });
});

test('native command runner preserves a numeric no-match exit status', async () => {
  const { runProcessCommand } = await import('../src/command-runner.js');
  await expect(runProcessCommand({ command: process.execPath, args: ['-e', 'process.exit(1)'] }))
    .resolves.toEqual({ exitCode: 1, stdout: '', stderr: '' });
});

test.each([
  'unparseable', '42', '42                         ', `43 ${posixToken}\n`,
  `42 ${posixToken}\n42 ${posixToken}\n`, `42 ${posixToken} node private arguments\n`,
])('Posix reader rejects ambiguous or invalid identity output %j', async (stdout) => {
  const runner: ProcessCommandRunner = async () => ({ exitCode: 0, stderr: '', stdout });

  await expect(createPosixProcessIdentityReader({ runner }).readIdentity({ pid: 42 }))
    .rejects.toMatchObject({ code: processControlErrorCodes.processIdentityUnavailable });
});

test('Posix reader rejects nonempty output with a failed exit status', async () => {
  const runner: ProcessCommandRunner = async () => ({ exitCode: 1, stderr: '', stdout: `42 ${posixToken}\n` });

  await expect(createPosixProcessIdentityReader({ runner }).readIdentity({ pid: 42 }))
    .rejects.toMatchObject({ code: processControlErrorCodes.commandFailed });
});


test.runIf(process.platform === 'win32')('Windows reader works without cmdlet module loading', async () => {
  const { runProcessCommand } = await import('../src/command-runner.js');
  const reader = createWindowsProcessIdentityReader({
    runner: (request) => runProcessCommand({
      ...request,
      args: [...request.args.slice(0, 3), "$PSModuleAutoLoadingPreference='None'; " + request.args[3]],
    }),
  });
  const first = await reader.readIdentity({ pid: process.pid, signal: AbortSignal.timeout(7_000) });
  expect(first.status).toBe('FOUND');
  if (first.status !== 'FOUND') {
    throw new Error('Expected the current process identity.');
  }
  expect(first.identity.pid).toBe(process.pid);
  expect(first.identity.startToken).toMatch(/^\/Date\(\d+\)\/$/u);
  await expect(reader.readIdentity({ pid: process.pid, signal: AbortSignal.timeout(7_000) }))
    .resolves.toEqual(first);
});
