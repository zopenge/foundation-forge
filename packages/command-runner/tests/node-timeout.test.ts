import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import process from 'node:process';
import { getEventListeners } from 'node:events';
import { expect, it, vi } from 'vitest';
import type { ProcessControlProvider } from '@openge/forge-process-control';
import type { CommandEvent } from '../src/index.js';
import { command, makeRunner, trackPid } from './helpers.js';

async function expectChildExited(pid: number): Promise<void> {
  // 失败结果交付时，操作系统可能仍在回收已经终止的子进程。
  await vi.waitFor(() => {
    expect(() => process.kill(pid, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }));
  }, { timeout: 1000, interval: 10 });
}

it('times out once, emits live heartbeats and cleans up its timers', async () => {
  const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
  const intervalSpy = vi.spyOn(globalThis, 'setInterval');
  const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
  const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
  try {
    const events: CommandEvent[] = [];
    const { runner, terminations } = makeRunner();
    const result = await runner.run(command('wait', [], { timeoutMs: 120, heartbeatMs: 20 }), event => events.push(event));
    expect(result.terminationReason).toBe('timeout');
    expect(terminations).toHaveLength(1);
    expect(events.filter(e => e.type === 'termination-requested')).toHaveLength(1);
    expect(events.filter(e => e.type === 'heartbeat').length).toBeGreaterThan(0);
    expect(events.filter(e => e.type === 'exited')).toHaveLength(1);
    for (const item of intervalSpy.mock.results) expect(clearIntervalSpy).toHaveBeenCalledWith(item.value);
    expect(timeoutSpy).toHaveBeenCalled();
    expect(clearTimeoutSpy).toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); }
});

it('natural exit cancels timeout and removes Abort listeners', async () => {
  const controller = new AbortController();
  const events: CommandEvent[] = [];
  const { runner, terminations } = makeRunner();
  const result = await runner.run(command('delay', ['30'], { timeoutMs: 1000, heartbeatMs: 10, signal: controller.signal }), event => events.push(event));
  controller.abort();
  expect(result.terminationReason).toBe('exit');
  expect(terminations).toHaveLength(0);
  expect(events.filter(e => e.type === 'exited')).toHaveLength(1);
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
});

it('fast exit settles identity even when identity observation never resolves', async () => {
  const base = makeRunner();
  const processControl: ProcessControlProvider = { ...base.provider, listProcesses: () => new Promise(() => {}) };
  const result = await makeRunner({ processControl, identityAcquisition: { timeoutMs: 1000, pollIntervalMs: 10 } }).runner.run(command('output'));
  expect(result.identity).toBeNull();
  expect(result.terminationReason).toBe('exit');
  expect(result.exitCode).toBe(0);
});

it.each(['missing', 'reject', 'hang'] as const)('bounds %s identity acquisition and directly cleans the child', async mode => {
  const base = makeRunner();
  const processControl: ProcessControlProvider = {
    ...base.provider,
    listProcesses: request => {
      for (const pid of request?.pids ?? []) trackPid(pid);
      if (mode === 'hang') return new Promise(() => {});
      if (mode === 'reject') return Promise.reject(new Error('lookup failed'));
      return Promise.resolve([]);
    },
  };
  const running = makeRunner({ processControl, identityAcquisition: { timeoutMs: 80, pollIntervalMs: 10 } }).runner.start(command('wait'));
  const pid = await running.pid;
  const result = await running.result;
  expect(await running.identity).toBeNull();
  expect(result.terminationReason).toBe('start-failure');
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'COMMAND_IDENTITY_UNAVAILABLE' }));
  expect(base.terminations).toHaveLength(0);
  await expectChildExited(pid);
});

it.each(['reject', 'hang', 'no-exit'] as const)('bounds Provider termination %s and cleans the child', async mode => {
  const base = makeRunner();
  let providerSignal: AbortSignal | undefined;
  const processControl: ProcessControlProvider = {
    ...base.provider,
    terminateProcessTree: request => {
      providerSignal = request.signal;
      if (mode === 'hang') return new Promise(() => {});
      if (mode === 'reject') return Promise.reject(new Error('termination failed'));
      return Promise.resolve({ pid: request.process.pid, forced: false });
    },
  };
  const running = makeRunner({ processControl, terminationTimeoutMs: 80 }).runner.start(command('wait', [], { timeoutMs: 40 }));
  const pid = await running.pid;
  const result = await running.result;
  expect(result.terminationReason).toBe('termination-failure');
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'COMMAND_TERMINATION_FAILED' }));
  expect(providerSignal?.aborted).toBe(true);
  await expectChildExited(pid);
});

it('includes identity waiting in the total manual termination budget', async () => {
  const base = makeRunner();
  const processControl: ProcessControlProvider = { ...base.provider, listProcesses: () => new Promise(() => {}) };
  const running = makeRunner({ processControl, identityAcquisition: { timeoutMs: 2000, pollIntervalMs: 10 }, terminationTimeoutMs: 60 }).runner.start(command('wait'));
  const pid = await running.pid;
  trackPid(pid);
  await running.terminate();
  expect((await running.result).terminationReason).toBe('termination-failure');
  expect(base.terminations).toHaveLength(0);
  await expectChildExited(pid);
});

it('bounds pipe closure after natural exit while its descendant owns inherited output', async () => {
  const marker = fileURLToPath(new URL('../../../.tmp/logs/command-runner-pipe-' + randomUUID() + '.txt', import.meta.url));
  await mkdir(dirname(marker), { recursive: true });
  try {
    const { runner, terminations } = makeRunner({ terminationTimeoutMs: 60 });
    const result = await runner.run(command('hold-pipe', [marker]));
    expect(result.terminationReason).toBe('termination-failure');
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'COMMAND_TERMINATION_FAILED', details: { stage: 'stream-close-deadline' } }));
    expect(terminations).toHaveLength(0);
  } finally {
    let cleaned = false;
    for (let attempt = 0; attempt < 150; attempt += 1) {
      try { cleaned = await readFile(marker, 'utf8') === 'cleaned'; } catch { /* 等待后代自行退出并确认清理。 */ }
      if (cleaned) break;
      await sleep(20);
    }
    expect(cleaned).toBe(true);
    await rm(marker, { force: true });
  }
});
