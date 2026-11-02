import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProcessIdentityReader, ReadProcessIdentityResult } from '@openge/forge-process-control';
import { ProcessControlError, processControlErrorCodes } from '@openge/forge-process-control';
import { Execution } from '../src/node/execution.js';

const probe = vi.hoisted(() => ({ legacyCalls: 0, nativePids: [] as number[], spawned: [] as number[], timeouts: [] as number[],
  simulate: false, native: undefined as ProcessIdentityReader | undefined,
  results: [] as { termination: string; stages: unknown[] }[] }));

vi.mock('@openge/forge-process-control-node', async importOriginal => {
  const actual = await importOriginal<typeof import('@openge/forge-process-control-node')>();
  return { ...actual,
    createWindowsProcessIdentityReader: (): ProcessIdentityReader => {
      probe.legacyCalls++;
      return { readIdentity: request => new Promise((_accept, reject) => {
        const stop = () => { request.signal?.removeEventListener('abort', stop); reject(new Error('fixture identity query stopped')); };
        if (request.signal?.aborted) stop(); else request.signal?.addEventListener('abort', stop, { once: true });
      }) };
    },
    createWindowsNativeProcessIdentityReader: (): ProcessIdentityReader => {
      const reader = actual.createWindowsNativeProcessIdentityReader();
      return { readIdentity: request => { probe.nativePids.push(request.pid); return (probe.native ?? reader).readIdentity(request); } };
    },
  };
});
vi.mock('@openge/forge-command-runner/node', async importOriginal => {
  const actual = await importOriginal<typeof import('@openge/forge-command-runner/node')>();
  return { ...actual, createNodeCommandRunner: (...args: Parameters<typeof actual.createNodeCommandRunner>) => {
    const runner = actual.createNodeCommandRunner(...args);
    return { ...runner, run: async (...parameters: Parameters<typeof runner.run>) => {
      probe.timeouts.push(parameters[0].timeoutMs ?? 0);
      if (probe.simulate) return { identity: null, exitCode: 0, signal: null, durationMs: 0, terminationReason: 'exit' as const,
        diagnostics: [], stdout: new Uint8Array(), stderr: new Uint8Array() };
      const result = await runner.run(parameters[0], event => {
        if (event.type === 'spawned') probe.spawned.push(event.pid);
        parameters[1]?.(event);
      });
      probe.results.push({ termination: result.terminationReason, stages: result.diagnostics.map(value => value.details.stage) });
      return result;
    } };
  } };
});
afterEach(() => {
  vi.restoreAllMocks(); vi.useRealTimers(); probe.legacyCalls = 0; probe.nativePids = []; probe.spawned = []; probe.timeouts = [];
  probe.results = []; probe.simulate = false; probe.native = undefined;
});
const windows = it.runIf(process.platform === 'win32' && process.arch === 'x64');
const limits = { commandMs: 5000, deploymentMs: 1000, pollMs: 20, requestMs: 1000, maxOutputBytes: 4096 };
const execution = (signal?: AbortSignal) => new Execution(resolve(import.meta.dirname, '../../..'), { limits }, signal, []);
const check = { command: 'node', args: ['-e', 'process.exit(0)'], timeoutMs: 1000 };

windows('does not use a command identity backend for startup or timeout termination', async context => {
  const run = execution(context.signal);
  await run.run('warmup', check, 'CHECK_FAILED');
  await expect(run.run('short', { command: 'node', args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 50 }, 'CHECK_FAILED'))
    .rejects.toMatchObject({ code: 'COMMAND_TIMEOUT' });
  expect(probe.results.at(-1), JSON.stringify(probe.results)).toMatchObject({ termination: 'timeout' });
  expect(probe.legacyCalls).toBe(0);
  const pid = probe.spawned.at(-1); expect(pid).toBeTypeOf('number');
  expect(probe.nativePids.filter(value => value === pid).length).toBeGreaterThanOrEqual(2);
});

windows('fails before spawning when native identity capability is unavailable', async context => {
  probe.simulate = true;
  probe.native = { readIdentity: async () => { throw new ProcessControlError(processControlErrorCodes.unsupportedBackend); } };
  await expect(execution(context.signal).run('unsupported', check, 'CHECK_FAILED'))
    .rejects.toMatchObject({ code: 'SOURCE_UNSUPPORTED' });
  expect(probe.timeouts).toEqual([]); expect(probe.legacyCalls).toBe(0);
});

windows('retains only structured native failure facts in capability diagnostics', async context => {
  probe.simulate = true;
  probe.native = { readIdentity: async () => { throw new ProcessControlError(processControlErrorCodes.commandFailed,
    { stage: 'OPEN_PROCESS', nativeCode: 5, stderr: 'token=PRIVATE_FIXTURE' }); } };
  const error = await execution(context.signal).run('unavailable', check, 'CHECK_FAILED').then(() => undefined, value => value);
  expect(error).toMatchObject({ code: 'SOURCE_UNSUPPORTED', details: { reason: 'NATIVE_IDENTITY_UNAVAILABLE',
    causeCode: processControlErrorCodes.commandFailed, stage: 'OPEN_PROCESS', nativeCode: 5 } });
  expect(JSON.stringify(error)).not.toContain('PRIVATE_FIXTURE'); expect(probe.timeouts).toEqual([]);
});

windows.each(['run', 'stream'] as const)('deducts native readiness time from the original %s budget', async mode => {
  probe.simulate = true;
  let elapsed = 0; vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
  probe.native = { readIdentity: async ({ pid }) => { elapsed += 300; return { status: 'FOUND', identity: { pid, startToken: 'fixture' } }; } };
  const run = execution();
  if (mode === 'run') await run.run('budget', check, 'CHECK_FAILED');
  else await run.streamGit(['--version'], () => {});
  expect(probe.timeouts).toEqual([mode === 'run' ? 700 : 4700]); expect(probe.legacyCalls).toBe(0);
});

windows('rejects readiness past the identity cap before a delayed timer can run', async () => {
  probe.simulate = true;
  let elapsed = 0; vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
  probe.native = { readIdentity: async ({ pid }) => { elapsed = 10_001; return { status: 'FOUND', identity: { pid, startToken: 'late' } }; } };
  const run = new Execution(process.cwd(), { limits: { ...limits, commandMs: 15_000 } }, undefined, []);
  await expect(run.run('late-native', { ...check, timeoutMs: 15_000 }, 'CHECK_FAILED'))
    .rejects.toMatchObject({ code: 'SOURCE_UNSUPPORTED', details: { reason: 'NATIVE_IDENTITY_DEADLINE' } });
  expect(probe.timeouts).toEqual([]); expect(probe.legacyCalls).toBe(0);
});

windows.each(['timeout', 'cancel'] as const)('bounds an uncooperative readiness reader on %s and never starts a late command', async mode => {
  probe.simulate = true;
  let finish!: (value: ReadProcessIdentityResult) => void;
  probe.native = { readIdentity: () => new Promise(resolve => { finish = resolve; }) };
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const controller = new AbortController();
  const result = execution(controller.signal).run('pending', { ...check, timeoutMs: 50 }, 'CHECK_FAILED')
    .then(() => ({ ok: true }), error => ({ ok: false, error }));
  await Promise.resolve();
  if (mode === 'cancel') controller.abort();
  await vi.advanceTimersByTimeAsync(51);
  expect(await result).toMatchObject({ ok: false, error: { code: mode === 'cancel' ? 'CANCELLED' : 'COMMAND_TIMEOUT' } });
  expect(probe.timeouts).toEqual([]); expect(probe.legacyCalls).toBe(0);
  finish({ status: 'FOUND', identity: { pid: process.pid, startToken: 'late' } }); await Promise.resolve();
  expect(probe.timeouts).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

windows.each(['absent', 'wrong-pid', 'empty-token'] as const)('rejects native capability %s before any command', async mode => {
  probe.simulate = true;
  probe.native = { readIdentity: async ({ pid }) => mode === 'absent' ? { status: 'ABSENT' }
    : { status: 'FOUND', identity: { pid: mode === 'wrong-pid' ? pid + 1 : pid, startToken: mode === 'empty-token' ? '' : 'fixture' } } };
  await expect(execution().streamGit(['--version'], () => {})).rejects.toMatchObject({ code: 'SOURCE_UNSUPPORTED' });
  expect(probe.timeouts).toEqual([]); expect(probe.legacyCalls).toBe(0);
});
