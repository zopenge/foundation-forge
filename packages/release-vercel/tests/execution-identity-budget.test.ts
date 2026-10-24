import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProcessIdentityReader, ReadProcessIdentityRequest, ReadProcessIdentityResult } from '@openge/forge-process-control';
import { Execution } from '../src/node/execution.js';

const probe = vi.hoisted((): { read?: ProcessIdentityReader['readIdentity'] } => ({}));
// 只控制身份观测边界；命令执行、退出事件及直接子进程清理均使用真实 Node 进程。
vi.mock('@openge/forge-process-control-node', async importOriginal => {
  const actual = await importOriginal<typeof import('@openge/forge-process-control-node')>();
  const reader = (): ProcessIdentityReader => ({ readIdentity: request => {
    if (!probe.read) throw new Error('identity probe was not installed');
    return probe.read(request);
  } });
  return { ...actual, createWindowsProcessIdentityReader: reader, createPosixProcessIdentityReader: reader };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
afterEach(() => { vi.useRealTimers(); delete probe.read; });

async function controlledCommand() {
  const base = resolve(import.meta.dirname, '../../../.tmp/execution-identity');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(resolve(base, 'r-')), marker = resolve(root, 'finish');
  const observed = deferred<ReadProcessIdentityRequest>(), identity = deferred<ReadProcessIdentityResult>();
  const ready = deferred<undefined>(), controller = new AbortController();
  probe.read = request => { observed.resolve(request); return identity.promise; };
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const execution = new Execution(root, { limits: { commandMs: 15_000, deploymentMs: 1000, pollMs: 20, requestMs: 1000, maxOutputBytes: 4096 } }, controller.signal, []);
  const result = execution.run('identity-budget', { command: 'node', args: ['-e',
    'const fs=require("node:fs");process.stdout.write("ready\\n");setInterval(()=>{if(fs.existsSync(process.argv[1]))process.exit(0)},10);setTimeout(()=>process.exit(91),20000)', marker] }, 'CHECK_FAILED', undefined, undefined, true,
  text => { if (text.includes('ready')) ready.resolve(undefined); })
    .then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
  const early = result.then(() => { throw new Error('command ended before the observation barrier'); });
  void early.catch(() => {});
  let request: ReadProcessIdentityRequest;
  try { [request] = await Promise.race([Promise.all([observed.promise, ready.promise]), early]); }
  catch (error) { controller.abort(); identity.resolve({ status: 'ABSENT' }); vi.useRealTimers(); await result; await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); throw error; }
  return { request, result, controller,
    identify: () => identity.resolve({ status: 'FOUND', identity: { pid: request.pid, startToken: 'controlled-observation' } }),
    finish: () => writeFile(marker, 'finish'),
    dispose: async () => {
      controller.abort(); identity.resolve({ status: 'ABSENT' });
      await vi.advanceTimersByTimeAsync(6000);
      vi.useRealTimers(); await result;
      await vi.waitFor(() => expect(() => process.kill(request.pid, 0)).toThrow(), { timeout: 2000, interval: 10 });
      // Windows 在进程终止后可能短暂持有 cwd；沿用真实 fixture 的有界目录回收策略。
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } };
}

it('allows a management identity observation beyond two seconds within the command budget', async () => {
  const command = await controlledCommand();
  try {
    await vi.advanceTimersByTimeAsync(2100);
    expect(command.request.signal?.aborted).toBe(false);
    command.identify(); await vi.advanceTimersByTimeAsync(0);
    await command.finish();
    expect(await command.result).toEqual({ ok: true });
  } finally { await command.dispose(); }
});

it('still fails closed at the identity deadline and cleans the actual child', async () => {
  const command = await controlledCommand();
  try {
    await vi.advanceTimersByTimeAsync(10_001);
    expect(command.request.signal?.aborted).toBe(true);
    expect(await command.result).toMatchObject({ ok: false, error: { code: 'CHECK_FAILED', details: { termination: 'start-failure' } } });
  } finally { await command.dispose(); }
});

it('cancels a pending identity observation and cleans the actual child', async () => {
  const command = await controlledCommand();
  try {
    command.controller.abort(); await vi.advanceTimersByTimeAsync(5001);
    expect(await command.result).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(command.request.signal?.aborted).toBe(true);
  } finally { await command.dispose(); }
});
