import type { ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { runGitCommand } from '../src/git-process.js';

const observed = vi.hoisted((): { closed: boolean[]; drains: Promise<void>[] } => ({ closed: [], drains: [] }));
// 保留真实 Git 与 AbortSignal，只记录本用例所启动进程的 close。
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const track = <T extends ChildProcess>(child: T): T => {
    const index = observed.closed.push(false) - 1;
    observed.drains.push(new Promise(accept => child.once('close', () => { observed.closed[index] = true; accept(); })));
    return child;
  };
  return { ...actual,
    execFile: (...args: Parameters<typeof actual.execFile>) => track(actual.execFile(...args)),
    spawn: (...args: Parameters<typeof actual.spawn>) => track(actual.spawn(...args)),
  };
});

it.for(['exec-file', 'stdin'] as const)('waits for actual Git closure before rejecting cancellation: %s', { timeout: 15_000 }, async (mode, context) => {
  const controller = new AbortController(), index = observed.closed.length;
  try {
    const work = runGitCommand(['cat-file', '--batch'], { cwd: resolve(import.meta.dirname, '../../..'),
      signal: AbortSignal.any([context.signal, controller.signal]), ...(mode === 'stdin' ? { input: '' } : {}) });
    controller.abort(new Error('fixture cancellation'));
    await expect(work).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
    expect(observed.closed.length).toBe(index + 1);
    expect(observed.closed[index]).toBe(true);
  } finally {
    controller.abort();
    await Promise.all(observed.drains.slice(index));
  }
});
