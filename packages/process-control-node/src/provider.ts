import {
  ProcessControlError,
  processControlErrorCodes,
  selectTcpListeners,
  type ListProcessesRequest,
  type ListTcpListenersRequest,
  type ProcessControlProvider,
  type ProcessDescriptor,
  type ProcessIdentity,
  type ProcessTerminationResult,
  type TcpListener,
  type TerminateProcessRequest,
  type TerminateProcessTreeRequest,
} from '@openge/forge-process-control';

import { runProcessCommand } from './command-runner.js';
import type {
  PosixProcessControlOptions,
  ProcessCommandResult,
  ProcessCommandRunner,
  WindowsProcessControlOptions,
} from './contracts.js';

export function createWindowsProcessControl(
  options: WindowsProcessControlOptions,
): ProcessControlProvider {
  return createProvider({ platform: 'windows', ...options });
}

export function createPosixProcessControl(
  options: PosixProcessControlOptions,
): ProcessControlProvider {
  return createProvider({ platform: 'posix', ...options });
}

type ProviderOptions =
  | ({ readonly platform: 'posix' } & PosixProcessControlOptions)
  | ({ readonly platform: 'windows' } & WindowsProcessControlOptions);

function createProvider(options: ProviderOptions): ProcessControlProvider {
  const runner = options.runner ?? runProcessCommand;
  return {
    listProcesses: (request = {}) => listProcesses(options, runner, request),
    listTcpListeners: (request = {}) => listTcpListeners(options, runner, request),
    terminateProcess: (request) => terminateProcess(options, runner, request, false),
    terminateProcessTree: (request) => terminateProcess(options, runner, request, true),
  };
}

async function listProcesses(
  options: ProviderOptions,
  runner: ProcessCommandRunner,
  request: ListProcessesRequest,
): Promise<readonly ProcessDescriptor[]> {
  const pids = request.pids === undefined ? undefined : validateProcessIds(request.pids);
  if (pids?.length === 0) {
    return [];
  }
  const descriptors = options.platform === 'windows'
    ? await describeWindowsProcesses(pids, runner, request.signal)
    : await describePosixProcesses(pids, runner, request.signal);
  return [...descriptors.values()].toSorted((left, right) => left.pid - right.pid);
}

async function listTcpListeners(
  options: ProviderOptions,
  runner: ProcessCommandRunner,
  request: ListTcpListenersRequest,
): Promise<readonly TcpListener[]> {
  const candidates = options.platform === 'windows'
    ? await listWindowsCandidates(options.listenerBackend, runner, request)
    : await listPosixCandidates(runner, request);
  const requestedPorts = request.ports ?? [...new Set(candidates.map((listener) => listener.port))];
  const filteredCandidates = candidates.filter((listener) => requestedPorts.includes(listener.port));
  if (filteredCandidates.length === 0) {
    return [];
  }
  const pids = [...new Set(filteredCandidates.map((listener) => listener.pid))].toSorted((a, b) => a - b);
  const identities = new Map((await listProcesses(options, runner, {
    pids,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  })).map((process) => [process.pid, process]));
  const listeners = filteredCandidates.map((listener): TcpListener => {
    const process = identities.get(listener.pid);
    if (process === undefined) {
      throw new ProcessControlError(processControlErrorCodes.processIdentityUnavailable, {
        pid: listener.pid,
      });
    }
    return { address: listener.address, port: listener.port, process };
  });
  return selectTcpListeners(listeners, { ports: requestedPorts });
}

interface ListenerCandidate {
  readonly address: string;
  readonly pid: number;
  readonly port: number;
}

async function listWindowsCandidates(
  backend: WindowsProcessControlOptions['listenerBackend'],
  runner: ProcessCommandRunner,
  request: ListTcpListenersRequest,
): Promise<readonly ListenerCandidate[]> {
  if (backend === 'powershell') {
    const result = await runner({
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-NetTCPConnection -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress',
      ],
      command: 'powershell.exe',
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    assertCommandSucceeded(result, 'powershell.exe');
    return parseWindowsPowerShellListeners(result.stdout);
  }
  const result = await runner({
    args: ['-ano', '-p', 'tcp'],
    command: 'netstat.exe',
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
  assertCommandSucceeded(result, 'netstat.exe');
  return parseWindowsNetstatListeners(result.stdout);
}

async function listPosixCandidates(
  runner: ProcessCommandRunner,
  request: ListTcpListenersRequest,
): Promise<readonly ListenerCandidate[]> {
  const result = await runner({
    args: ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'],
    command: 'lsof',
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
  if (result.exitCode === 1 && result.stdout.trim().length === 0 && result.stderr.trim().length === 0) {
    return [];
  }
  assertCommandSucceeded(result, 'lsof');
  return parsePosixLsofListeners(result.stdout);
}

async function describeWindowsProcesses(
  pids: readonly number[] | undefined,
  runner: ProcessCommandRunner,
  signal: AbortSignal | undefined,
): Promise<ReadonlyMap<number, ProcessDescriptor>> {
  const processCommand = pids === undefined
    ? 'Get-CimInstance Win32_Process'
    : `Get-CimInstance Win32_Process -Filter "${pids.map((pid) => `ProcessId=${String(pid)}`).join(' OR ')}"`;
  const result = await runner({
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `${processCommand} | Select-Object ProcessId,ParentProcessId,CreationDate,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress`,
    ],
    command: 'powershell.exe',
    ...(signal === undefined ? {} : { signal }),
  });
  assertCommandSucceeded(result, 'powershell.exe');
  const values = parseJsonObjects(result.stdout);
  const identities = new Map<number, ProcessDescriptor>();
  for (const value of values) {
    const pid = readPositiveInteger(value.ProcessId);
    const startToken = readNonEmptyString(value.CreationDate);
    if (pid === undefined || startToken === undefined) {
      continue;
    }
    const command = readNonEmptyString(value.ExecutablePath) ?? readNonEmptyString(value.Name);
    const commandLine = readNonEmptyString(value.CommandLine);
    const name = readNonEmptyString(value.Name);
    const parentPid = readNonNegativeInteger(value.ParentProcessId);
    identities.set(pid, {
      ...(command === undefined ? {} : { command }),
      ...(commandLine === undefined ? {} : { commandLine }),
      ...(name === undefined ? {} : { name }),
      ...(parentPid === undefined ? {} : { parentPid }),
      pid,
      startToken,
    });
  }
  return identities;
}

async function describePosixProcesses(
  pids: readonly number[] | undefined,
  runner: ProcessCommandRunner,
  signal: AbortSignal | undefined,
): Promise<ReadonlyMap<number, ProcessDescriptor>> {
  const result = await runner({
    args: pids === undefined
      ? ['-eo', 'pid=,ppid=,lstart=,comm=,args=']
      : ['-o', 'pid=', '-o', 'ppid=', '-o', 'lstart=', '-o', 'comm=', '-o', 'args=', '-p', pids.join(',')],
    command: 'ps',
    ...(signal === undefined ? {} : { signal }),
  });
  if (result.exitCode === 1 && result.stdout.trim().length === 0 && result.stderr.trim().length === 0) {
    return new Map();
  }
  assertCommandSucceeded(result, 'ps');
  const identities = new Map<number, ProcessDescriptor>();
  const pattern = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(\S+)(?:\s+(.*))?$/u;
  for (const line of result.stdout.split(/\r?\n/u)) {
    const match = pattern.exec(line);
    if (match === null) {
      continue;
    }
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const startToken = match[3]?.trim() ?? '';
    const command = match[4]?.trim() ?? '';
    const commandLine = match[5]?.trim() ?? '';
    if (Number.isSafeInteger(pid) && pid > 0 && startToken.length > 0) {
      identities.set(pid, {
        ...(command.length === 0 ? {} : { command, name: command }),
        ...(commandLine.length === 0 ? {} : { commandLine }),
        ...(Number.isSafeInteger(parentPid) && parentPid >= 0 ? { parentPid } : {}),
        pid,
        startToken,
      });
    }
  }
  return identities;
}

function parseWindowsPowerShellListeners(output: string): readonly ListenerCandidate[] {
  const values = parseJsonObjects(output);
  const listeners: ListenerCandidate[] = [];
  for (const value of values) {
    const address = readNonEmptyString(value.LocalAddress);
    const port = readPositiveInteger(value.LocalPort);
    const pid = readPositiveInteger(value.OwningProcess);
    if (address !== undefined && port !== undefined && port <= 65_535 && pid !== undefined) {
      listeners.push({ address, pid, port });
    }
  }
  return listeners;
}

function parseWindowsNetstatListeners(output: string): readonly ListenerCandidate[] {
  const listeners: ListenerCandidate[] = [];
  const pattern = /^\s*TCP\s+(.+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/iu;
  for (const line of output.split(/\r?\n/u)) {
    const match = pattern.exec(line);
    if (match === null) {
      continue;
    }
    const port = Number(match[2]);
    const pid = Number(match[3]);
    if (Number.isSafeInteger(port) && port > 0 && port <= 65_535 && Number.isSafeInteger(pid) && pid > 0) {
      listeners.push({ address: stripAddressBrackets(match[1] ?? ''), pid, port });
    }
  }
  return listeners;
}

function parsePosixLsofListeners(output: string): readonly ListenerCandidate[] {
  const listeners: ListenerCandidate[] = [];
  let pid: number | undefined;
  for (const line of output.split(/\r?\n/u)) {
    if (line.startsWith('p')) {
      const candidate = Number(line.slice(1));
      pid = Number.isSafeInteger(candidate) && candidate > 0 ? candidate : undefined;
      continue;
    }
    if (!line.startsWith('n') || pid === undefined) {
      continue;
    }
    const endpoint = line.slice(1).split('->')[0] ?? '';
    const match = /^(.*):(\d+)$/u.exec(endpoint);
    if (match === null) {
      continue;
    }
    const port = Number(match[2]);
    if (Number.isSafeInteger(port) && port > 0 && port <= 65_535) {
      listeners.push({ address: stripAddressBrackets(match[1] ?? ''), pid, port });
    }
  }
  return listeners;
}

async function terminateProcess(
  options: ProviderOptions,
  runner: ProcessCommandRunner,
  request: TerminateProcessRequest | TerminateProcessTreeRequest,
  tree: boolean,
): Promise<ProcessTerminationResult> {
  validateTerminationRequest(request);
  assertNotAborted(request.signal);
  await assertProcessIdentity(options, runner, request.process, request.signal);

  if (request.policy.mode === 'force') {
    await sendTerminationSignal(options, runner, request.process.pid, true, tree, request.signal);
    return { forced: true, pid: request.process.pid };
  }

  await sendTerminationSignal(options, runner, request.process.pid, false, tree, request.signal);
  if (request.policy.mode === 'graceful') {
    return { forced: false, pid: request.process.pid };
  }

  const deadline = Date.now() + request.policy.gracePeriodMs;
  while (true) {
    assertNotAborted(request.signal);
    const current = await readProcessIdentity(options, runner, request.process.pid, request.signal);
    if (current === undefined) {
      return { forced: false, pid: request.process.pid };
    }
    assertSameProcessIdentity(request.process, current);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      await sendTerminationSignal(options, runner, request.process.pid, true, tree, request.signal);
      return { forced: true, pid: request.process.pid };
    }
    await delay(Math.min(request.policy.pollIntervalMs, remainingMs), request.signal);
  }
}

function validateTerminationRequest(request: TerminateProcessTreeRequest): void {
  if (
    !Number.isSafeInteger(request.process.pid)
    || request.process.pid <= 0
    || request.process.startToken.length === 0
  ) {
    throw new ProcessControlError(processControlErrorCodes.invalidInput);
  }
  if (
    request.policy.mode === 'graceful-then-force'
    && (
      !Number.isSafeInteger(request.policy.gracePeriodMs)
      || request.policy.gracePeriodMs < 0
      || !Number.isSafeInteger(request.policy.pollIntervalMs)
      || request.policy.pollIntervalMs <= 0
    )
  ) {
    throw new ProcessControlError(processControlErrorCodes.invalidInput);
  }
}

async function assertProcessIdentity(
  options: ProviderOptions,
  runner: ProcessCommandRunner,
  expected: ProcessIdentity,
  signal: AbortSignal | undefined,
): Promise<void> {
  const current = await readProcessIdentity(options, runner, expected.pid, signal);
  if (current === undefined) {
    throw new ProcessControlError(processControlErrorCodes.processIdentityUnavailable, {
      pid: expected.pid,
    });
  }
  assertSameProcessIdentity(expected, current);
}

async function readProcessIdentity(
  options: ProviderOptions,
  runner: ProcessCommandRunner,
  pid: number,
  signal: AbortSignal | undefined,
): Promise<ProcessIdentity | undefined> {
  const identities = options.platform === 'windows'
    ? await describeWindowsProcesses([pid], runner, signal)
    : await describePosixProcesses([pid], runner, signal);
  return identities.get(pid);
}

function assertSameProcessIdentity(expected: ProcessIdentity, current: ProcessIdentity): void {
  if (expected.startToken !== current.startToken) {
    throw new ProcessControlError(processControlErrorCodes.processIdentityChanged, {
      actualStartToken: current.startToken,
      expectedStartToken: expected.startToken,
      pid: expected.pid,
    });
  }
}

async function sendTerminationSignal(
  options: ProviderOptions,
  runner: ProcessCommandRunner,
  pid: number,
  force: boolean,
  tree: boolean,
  signal: AbortSignal | undefined,
): Promise<void> {
  const request = options.platform === 'windows'
    ? {
      args: [
        '/PID',
        String(pid),
        ...(tree ? ['/T'] : []),
        ...(force ? ['/F'] : []),
      ],
      command: 'taskkill.exe',
      ...(signal === undefined ? {} : { signal }),
    }
    : {
      args: [force ? '-KILL' : '-TERM', '--', tree ? `-${String(pid)}` : String(pid)],
      command: 'kill',
      ...(signal === undefined ? {} : { signal }),
    };
  const result = await runner(request);
  assertCommandSucceeded(result, request.command);
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new ProcessControlError(processControlErrorCodes.operationAborted);
  }
}

async function delay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      reject(new ProcessControlError(processControlErrorCodes.operationAborted));
    };
    if (signal === undefined) {
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

function parseJsonObjects(output: string): readonly Record<string, unknown>[] {
  if (output.trim().length === 0) {
    return [];
  }
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch (error) {
    throw new ProcessControlError(processControlErrorCodes.commandFailed, {}, error);
  }
  const values = Array.isArray(value) ? value : [value];
  return values.filter(isRecord);
}

function assertCommandSucceeded(result: ProcessCommandResult, command: string): void {
  if (result.exitCode !== 0) {
    throw new ProcessControlError(processControlErrorCodes.commandFailed, {
      command,
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
  }
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function readNonNegativeInteger(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function validateProcessIds(pids: readonly number[]): readonly number[] {
  const validated = new Set<number>();
  for (const pid of pids) {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new ProcessControlError(processControlErrorCodes.invalidInput, { pid });
    }
    validated.add(pid);
  }
  return [...validated].toSorted((left, right) => left - right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripAddressBrackets(address: string): string {
  return address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
}
