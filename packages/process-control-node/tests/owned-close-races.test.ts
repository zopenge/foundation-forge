import { performance } from 'node:perf_hooks';
import { expect, test, vi } from 'vitest';
import { startSupervisor } from '../dist/owned-scope/supervisor.js';

test.runIf(process.platform === 'win32')('force interrupts an already-started normal finish and cannot become normal', async () => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(accept => { enter = accept; });
  const gate = new Promise<void>(accept => { release = accept; });
  let forces = 0;
  const scope = startSupervisor({ command: process.execPath, args: ['-e', 'process.exit(0)'],
    environment: process.env, binding: 'closing-race', startupTimeoutMs: 5000, terminationTimeoutMs: 3000 },
  'win32', async () => ({ attach: async () => {}, bind: async () => {},
    empty: async rootExited => { if (!rootExited) { enter(); await gate; } return true; },
    force: async () => { forces += 1; }, dispose: async () => {},
  }));
  try {
    await scope.bind({ pid: await scope.rootPid, startToken: 'controlled-backend' });
    await scope.authorize(); await entered;
    const stopped = scope.terminate({ mode: 'force' });
    release();
    expect(await stopped).toMatchObject({ status: 'unknown', reason: 'terminated' });
    expect((await scope.completion).closure.status).toBe('unknown');
    expect(forces).toBe(1);
  } finally { release(); await scope.dispose(); }
}, 10000);

test.runIf(process.platform === 'win32')('normal close and final Job verification share one monotonic deadline', async () => {
  let now = 1000;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  const deadlines: number[] = [];
  const scope = startSupervisor({ command: process.execPath, args: ['-e', 'process.exit(0)'],
    environment: process.env, binding: 'shared-deadline', startupTimeoutMs: 5000, terminationTimeoutMs: 5000 },
  'win32', async () => ({ attach: async () => {}, bind: async () => {},
    empty: async (rootExited, budget) => { deadlines.push(budget.deadline); if (!rootExited) now = 1500; return true; },
    force: async () => {}, dispose: async () => {},
  }));
  try {
    await scope.bind({ pid: await scope.rootPid, startToken: 'controlled-backend' });
    await scope.authorize();
    expect((await scope.completion).closure.status).toBe('closed');
    expect(deadlines).toEqual([2000, 6000]);
  } finally { await scope.dispose(); clock.mockRestore(); }
}, 10000);
