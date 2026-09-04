import { ChildProcess, spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProcessControlProvider, ProcessDescriptor } from '@openge/forge-process-control';
import type { CommandEvent } from '../src/index.js';
import { createNodeCommandRunner } from '../src/node.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
function controlled(listProcesses?: ProcessControlProvider['listProcesses'], platform: 'posix' | 'win32' = 'posix') {
  const child = new ChildProcess();
  Object.defineProperty(child, 'pid', { value: 43210 });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const terminateProcessTree = vi.fn<ProcessControlProvider['terminateProcessTree']>();
  const processControl: ProcessControlProvider = {
    listProcesses: listProcesses ?? (async () => [{ pid: 43210, startToken: 'controlled' }]),
    async listTcpListeners() { return []; },
    async terminateProcess() { throw new Error('unexpected'); },
    terminateProcessTree,
  };
  vi.mocked(spawn).mockReturnValue(child);
  const runner = createNodeCommandRunner({ platform, processControl, terminationPolicy: { mode: 'force' }, identityAcquisition: { timeoutMs: 1000, pollIntervalMs: 10 }, terminationTimeoutMs: 100 });
  return { child, runner, terminateProcessTree };
}

it('reports capture overflow from buffered output delivered after process exit', async () => {
  const { child, runner, terminateProcessTree } = controlled();
  const running = runner.start({ command: 'controlled', output: { mode: 'capture', maxBytesPerStream: 2, overflow: 'fail' } });
  child.emit('spawn');
  await running.identity;
  child.emit('exit', 0, null);
  child.stdout?.emit('data', new Uint8Array([1, 2, 3]));
  child.emit('close', 0, null);
  const result = await running.result;
  expect(result.terminationReason).toBe('output-overflow');
  expect(result.stdout).toEqual(new Uint8Array([1, 2]));
  expect(terminateProcessTree).not.toHaveBeenCalled();
});

it('settles before a late identity response and removes timers and process listeners', async () => {
  vi.useFakeTimers();
  let resolveLookup!: (value: readonly ProcessDescriptor[]) => void;
  const { child, runner } = controlled(() => new Promise(resolve => { resolveLookup = resolve; }));
  const events: CommandEvent[] = [];
  const running = runner.start({ command: 'controlled', timeoutMs: 5000, heartbeatMs: 5 }, event => events.push(event));
  child.emit('spawn');
  await Promise.resolve();
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
  const result = await running.result;
  expect(result.identity).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  for (const event of ['spawn', 'exit', 'close', 'error']) expect(child.listenerCount(event)).toBe(0);
  expect(child.stdout?.listenerCount('data')).toBe(0);
  expect(child.stderr?.listenerCount('data')).toBe(0);
  resolveLookup([{ pid: 43210, startToken: 'too-late' }]);
  await Promise.resolve();
  expect(events.some(event => event.type === 'identified')).toBe(false);
});

it.each(['posix', 'win32'] as const)('creates a process group only for explicit %s platform', async platform => {
  const { child, runner } = controlled(undefined, platform);
  const running = runner.start({ command: 'controlled' });
  child.emit('spawn');
  await running.identity;
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
  await running.result;
  expect(vi.mocked(spawn).mock.calls.at(-1)?.[2]?.detached).toBe(platform === 'posix');
});

it('bounds reentrant kill errors and preserves post-spawn termination failure', async () => {
  vi.useFakeTimers();
  const { child, runner, terminateProcessTree } = controlled();
  terminateProcessTree.mockRejectedValue(new Error('provider failure'));
  let cleanupCalls = 0;
  vi.spyOn(child, 'kill').mockImplementation(() => {
    cleanupCalls += 1;
    if (cleanupCalls <= 5) child.emit('error', Object.assign(new Error('cleanup failure'), { code: 'EPERM' }));
    return false;
  });
  const running = runner.start({ command: 'controlled' });
  child.emit('spawn');
  await running.identity;
  await running.terminate();
  const result = await running.result;
  expect(result.terminationReason).toBe('termination-failure');
  expect(cleanupCalls).toBe(1);
  expect(result.diagnostics.some(value => value.code === 'COMMAND_START_FAILED')).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
