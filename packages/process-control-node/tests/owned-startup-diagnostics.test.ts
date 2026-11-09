import { afterEach, expect, test, vi } from 'vitest';
import { ProcessControlError } from '@openge/forge-process-control';
import { startSupervisor } from '../src/owned-scope/supervisor.js';
import type { ScopeBackend } from '../src/owned-scope/backend.js';

const calls = vi.hoisted(() => ({ spawns: 0 }));
// 启动失败的控制流单元不创建OS进程，也不把替身empty当作真实关闭证明。
vi.mock('node:child_process', () => ({ spawn: () => { calls.spawns++; throw new Error('unexpected process creation'); } }));
afterEach(() => { vi.useRealTimers(); calls.spawns = 0; });
const request = { command: 'must-not-run', environment: {}, binding: 'startup-diagnostic', startupTimeoutMs: 50, terminationTimeoutMs: 50 };

test.each([false, true])('retains the original boot deadline when initialization finishes late, cleanupFailure=%s', async cleanupFailure => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let release!: (backend: ScopeBackend) => void, forced = 0, disposed = 0, settled = false;
  const backend = new Promise<ScopeBackend>(accept => { release = accept; });
  const scope = startSupervisor(request, 'win32', () => backend);
  const result = scope.rootPid.then(() => undefined, (error: unknown) => error).finally(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(50);
  // 只改善分类，不把rootPid提前结算为已完成收尾。
  expect(settled).toBe(false); expect(calls.spawns).toBe(0);
  release({ attach: async () => {}, bind: async () => {}, empty: async () => true,
    force: async () => { forced++; if (cleanupFailure) throw new Error('private-cleanup'); },
    dispose: async () => { disposed++; } });
  try {
    const error = await result;
    if (!(error instanceof ProcessControlError)) throw new Error('expected classified startup failure');
    expect(error.code).toBe('PROCESS_SCOPE_UNKNOWN'); expect(error.details.reason).toBe('BOOT_DEADLINE');
    expect((await scope.completion).closure).toMatchObject({ status: 'unknown', reason: 'provider-failed' });
    expect(calls.spawns).toBe(0); expect(forced).toBe(1); expect(disposed).toBe(1);
  } finally { await scope.dispose(); }
});

test('retains the first native initialization error without starting a payload', async () => {
  const failure = new ProcessControlError('PROCESS_SCOPE_UNKNOWN', { stage: 'SET_JOB_LIMITS', nativeCode: 5 });
  const scope = startSupervisor(request, 'win32', async () => { throw failure; });
  try {
    const error = await scope.rootPid.then(() => undefined, (error: unknown) => error);
    expect(error).toBe(failure);
    expect((await scope.completion).closure).toMatchObject({ status: 'unknown', reason: 'provider-failed' });
    expect(calls.spawns).toBe(0);
  } finally { await scope.dispose(); }
});
