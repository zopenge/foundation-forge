import { expect, test, vi } from 'vitest';

import {
  processControlErrorCodes,
} from '@openge/forge-process-control';

import {
  createPosixProcessControl,
  createWindowsProcessControl,
  type ProcessCommandRequest,
  type ProcessCommandRunner,
} from '../src/index.js';

test('discovers Windows PowerShell listeners with verified process identities', async () => {
  const runner = sequenceRunner([
    {
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify([
        { LocalAddress: '127.0.0.1', LocalPort: 3000, OwningProcess: 42 },
        { LocalAddress: '::', LocalPort: 4000, OwningProcess: 43 },
      ]),
    },
    {
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify([
        { CreationDate: '20260903070000.000000+480', Name: 'node.exe', ProcessId: 42 },
      ]),
    },
  ]);
  const provider = createWindowsProcessControl({ listenerBackend: 'powershell', runner });

  await expect(provider.listTcpListeners({ ports: [3000] })).resolves.toEqual([{
    address: '127.0.0.1',
    port: 3000,
    process: {
      command: 'node.exe',
      name: 'node.exe',
      pid: 42,
      startToken: '20260903070000.000000+480',
    },
  }]);
});

test('discovers Posix lsof listeners with verified process identities', async () => {
  const runner = sequenceRunner([
    { exitCode: 0, stderr: '', stdout: 'p51\ncnode\nn127.0.0.1:5173\n' },
    { exitCode: 0, stderr: '', stdout: ' 51 7 Thu Sep  3 07:00:00 2026 node node app.js\n' },
  ]);
  const provider = createPosixProcessControl({ listenerBackend: 'lsof', runner });

  await expect(provider.listTcpListeners()).resolves.toEqual([{
    address: '127.0.0.1',
    port: 5173,
    process: {
      command: 'node',
      commandLine: 'node app.js',
      name: 'node',
      parentPid: 7,
      pid: 51,
      startToken: 'Thu Sep  3 07:00:00 2026',
    },
  }]);
});

test('lists Windows processes with stable identities and descriptive metadata', async () => {
  const runner = sequenceRunner([{
    exitCode: 0,
    stderr: '',
    stdout: JSON.stringify([
      {
        CommandLine: 'node app.js',
        CreationDate: '20260903070000.000000+480',
        ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe',
        Name: 'node.exe',
        ParentProcessId: 7,
        ProcessId: 42,
      },
      {
        CommandLine: 'cmd.exe /d /c pnpm dev',
        CreationDate: '20260903060000.000000+480',
        Name: 'cmd.exe',
        ParentProcessId: 1,
        ProcessId: 21,
      },
    ]),
  }]);
  const provider = createWindowsProcessControl({ listenerBackend: 'powershell', runner });

  await expect(provider.listProcesses()).resolves.toEqual([
    {
      command: 'cmd.exe',
      commandLine: 'cmd.exe /d /c pnpm dev',
      name: 'cmd.exe',
      parentPid: 1,
      pid: 21,
      startToken: '20260903060000.000000+480',
    },
    {
      command: 'C:\\Program Files\\nodejs\\node.exe',
      commandLine: 'node app.js',
      name: 'node.exe',
      parentPid: 7,
      pid: 42,
      startToken: '20260903070000.000000+480',
    },
  ]);
});

test('lists Posix processes with stable identities and descriptive metadata', async () => {
  const runner = sequenceRunner([{
    exitCode: 0,
    stderr: '',
    stdout: ' 51 7 Thu Sep  3 07:00:00 2026 node node app.js\n',
  }]);
  const provider = createPosixProcessControl({ listenerBackend: 'lsof', runner });

  await expect(provider.listProcesses()).resolves.toEqual([{
    command: 'node',
    commandLine: 'node app.js',
    name: 'node',
    parentPid: 7,
    pid: 51,
    startToken: 'Thu Sep  3 07:00:00 2026',
  }]);
});

test('treats an empty lsof result as no listeners', async () => {
  const provider = createPosixProcessControl({
    listenerBackend: 'lsof',
    runner: sequenceRunner([{ exitCode: 1, stderr: '', stdout: '' }]),
  });

  await expect(provider.listTcpListeners()).resolves.toEqual([]);
});

test('revalidates the Windows process identity before forcefully terminating its tree', async () => {
  const requests: ProcessCommandRequest[] = [];
  const runner = recordingSequenceRunner(requests, [
    {
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({
        CreationDate: '20260903070000.000000+480',
        Name: 'node.exe',
        ProcessId: 42,
      }),
    },
    { exitCode: 0, stderr: '', stdout: 'SUCCESS' },
  ]);
  const provider = createWindowsProcessControl({ listenerBackend: 'powershell', runner });

  await expect(provider.terminateProcessTree({
    policy: { mode: 'force' },
    process: { pid: 42, startToken: '20260903070000.000000+480' },
  })).resolves.toEqual({ forced: true, pid: 42 });
  expect(requests[1]).toMatchObject({
    args: ['/PID', '42', '/T', '/F'],
    command: 'taskkill.exe',
  });
});

test('revalidates identity before terminating only the selected Windows process', async () => {
  const requests: ProcessCommandRequest[] = [];
  const runner = recordingSequenceRunner(requests, [
    {
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({
        CreationDate: '20260903070000.000000+480',
        Name: 'node.exe',
        ProcessId: 42,
      }),
    },
    { exitCode: 0, stderr: '', stdout: 'SUCCESS' },
  ]);
  const provider = createWindowsProcessControl({ listenerBackend: 'powershell', runner });

  await expect(provider.terminateProcess({
    policy: { mode: 'force' },
    process: { pid: 42, startToken: '20260903070000.000000+480' },
  })).resolves.toEqual({ forced: true, pid: 42 });
  expect(requests[1]).toMatchObject({
    args: ['/PID', '42', '/F'],
    command: 'taskkill.exe',
  });
});

test('refuses termination when a PID has been reused', async () => {
  const runner = vi.fn<ProcessCommandRunner>().mockResolvedValue({
    exitCode: 0,
    stderr: '',
    stdout: JSON.stringify({
      CreationDate: '20260903080000.000000+480',
      Name: 'node.exe',
      ProcessId: 42,
    }),
  });
  const provider = createWindowsProcessControl({ listenerBackend: 'powershell', runner });

  const promise = provider.terminateProcessTree({
    policy: { mode: 'force' },
    process: { pid: 42, startToken: '20260903070000.000000+480' },
  });
  await expect(promise).rejects.toMatchObject({
    code: processControlErrorCodes.processIdentityChanged,
  });
  expect(runner).toHaveBeenCalledTimes(1);
});

test('escalates a Posix process group after the graceful deadline', async () => {
  const requests: ProcessCommandRequest[] = [];
  const runner = recordingSequenceRunner(requests, [
    { exitCode: 0, stderr: '', stdout: ' 51 7 Thu Sep  3 07:00:00 2026 node node app.js\n' },
    { exitCode: 0, stderr: '', stdout: '' },
    { exitCode: 0, stderr: '', stdout: ' 51 7 Thu Sep  3 07:00:00 2026 node node app.js\n' },
    { exitCode: 0, stderr: '', stdout: '' },
  ]);
  const provider = createPosixProcessControl({ listenerBackend: 'lsof', runner });

  await expect(provider.terminateProcessTree({
    policy: { gracePeriodMs: 0, mode: 'graceful-then-force', pollIntervalMs: 1 },
    process: { pid: 51, startToken: 'Thu Sep  3 07:00:00 2026' },
  })).resolves.toEqual({ forced: true, pid: 51 });
  expect(requests.map(({ args, command }) => ({ args, command }))).toEqual([
    { args: ['-o', 'pid=', '-o', 'ppid=', '-o', 'lstart=', '-o', 'comm=', '-o', 'args=', '-p', '51'], command: 'ps' },
    { args: ['-TERM', '--', '-51'], command: 'kill' },
    { args: ['-o', 'pid=', '-o', 'ppid=', '-o', 'lstart=', '-o', 'comm=', '-o', 'args=', '-p', '51'], command: 'ps' },
    { args: ['-KILL', '--', '-51'], command: 'kill' },
  ]);
});

test('escalates only the selected Posix process after the graceful deadline', async () => {
  const requests: ProcessCommandRequest[] = [];
  const runner = recordingSequenceRunner(requests, [
    { exitCode: 0, stderr: '', stdout: ' 51 7 Thu Sep  3 07:00:00 2026 node node app.js\n' },
    { exitCode: 0, stderr: '', stdout: '' },
    { exitCode: 0, stderr: '', stdout: ' 51 7 Thu Sep  3 07:00:00 2026 node node app.js\n' },
    { exitCode: 0, stderr: '', stdout: '' },
  ]);
  const provider = createPosixProcessControl({ listenerBackend: 'lsof', runner });

  await expect(provider.terminateProcess({
    policy: { gracePeriodMs: 0, mode: 'graceful-then-force', pollIntervalMs: 1 },
    process: { pid: 51, startToken: 'Thu Sep  3 07:00:00 2026' },
  })).resolves.toEqual({ forced: true, pid: 51 });
  expect(requests.map(({ args, command }) => ({ args, command }))).toEqual([
    { args: ['-o', 'pid=', '-o', 'ppid=', '-o', 'lstart=', '-o', 'comm=', '-o', 'args=', '-p', '51'], command: 'ps' },
    { args: ['-TERM', '--', '51'], command: 'kill' },
    { args: ['-o', 'pid=', '-o', 'ppid=', '-o', 'lstart=', '-o', 'comm=', '-o', 'args=', '-p', '51'], command: 'ps' },
    { args: ['-KILL', '--', '51'], command: 'kill' },
  ]);
});

function sequenceRunner(results: readonly Awaited<ReturnType<ProcessCommandRunner>>[]): ProcessCommandRunner {
  let index = 0;
  return async () => {
    const result = results[index];
    index += 1;
    if (result === undefined) {
      throw new Error('unexpected command');
    }
    return result;
  };
}

function recordingSequenceRunner(
  requests: ProcessCommandRequest[],
  results: readonly Awaited<ReturnType<ProcessCommandRunner>>[],
): ProcessCommandRunner {
  const runner = sequenceRunner(results);
  return async (request) => {
    requests.push(request);
    return runner(request);
  };
}
