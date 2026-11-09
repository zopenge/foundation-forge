import { once } from 'node:events';
import { expect, onTestFailed, test, vi } from 'vitest';
import { createWindowsNativeProcessIdentityReader, createWindowsProcessControl, createWindowsProcessIdentityReader } from '../src/index.js';
import { runProcessCommand } from '../src/command-runner.js';
import { liveTerminationChild } from './helpers/live-termination-child.js';

test.runIf(process.platform === 'win32')('revalidates a real CIM start token through the narrow reader before terminating its own child', async context => {
  const started = performance.now(), phases: { phase: string; elapsedMs: number }[] = [];
  const mark = (phase: string) => { phases.push({ phase, elapsedMs: Math.round(performance.now() - started) }); };
  // 只在失败时输出内存阶段记录，保持真实命令、流和原测试期限不变。
  onTestFailed(() => { process.stderr.write(`${JSON.stringify({ kind: 'WINDOWS_CIM_TERMINATION', elapsedMs: Math.round(performance.now() - started), phases })}\n`); });
  mark('child:start');
  const fixture = liveTerminationChild(context), { child, closed } = fixture;
  try {
    await once(child, 'spawn');
    mark('child:spawned');
    const pid = child.pid; if (!pid) throw new Error('fixture child unavailable');
    const provider = createWindowsProcessControl({ listenerBackend: 'netstat' });
    mark('cim:start');
    const processes = await provider.listProcesses({ pids: [pid], signal: fixture.signal });
    mark('cim:finished');
    expect(processes).toHaveLength(1);
    const identity = processes[0]; if (!identity) throw new Error('fixture identity unavailable');
    mark('reader-before:start');
    expect(await createWindowsProcessIdentityReader().readIdentity({ pid, signal: fixture.signal }))
      .toEqual({ status: 'FOUND', identity: { pid, startToken: identity.startToken } });
    mark('reader-before:finished');
    mark('terminate:start');
    await expect(provider.terminateProcessTree({ process: identity, policy: { mode: 'force' }, signal: fixture.signal }))
      .resolves.toEqual({ pid, forced: true });
    mark('terminate:finished');
    await closed; expect(fixture.error()).toBeUndefined();
    mark('child:closed');
    mark('reader-after:start');
    const observed = await createWindowsProcessIdentityReader().readIdentity({ pid, signal: fixture.signal });
    mark('reader-after:finished');
    if (observed.status === 'FOUND') expect(observed.identity.startToken).not.toBe(identity.startToken);
  } finally {
    mark('dispose:start');
    await fixture.dispose();
    mark('dispose:finished');
  }
});

test('closes the real test child on cancellation and waits for its close event', async context => {
  const controller = new AbortController(), fixture = liveTerminationChild(context, controller.signal);
  try {
    await once(fixture.child, 'spawn');
    controller.abort();
    await vi.waitFor(() => expect(fixture.child.exitCode !== null || fixture.child.signalCode !== null).toBe(true),
      { timeout: 1000, interval: 10 });
    await fixture.closed;
    await fixture.dispose();
  } finally { await fixture.dispose(); }
});

test.runIf(process.platform === 'win32' && process.arch === 'x64')('terminates its real child with an explicitly injected native identity reader and no PowerShell calls', async context => {
  const fixture = liveTerminationChild(context), reader = createWindowsNativeProcessIdentityReader();
  const commands: string[] = [];
  try {
    await once(fixture.child, 'spawn');
    const pid = fixture.child.pid; if (!pid) throw new Error('fixture child unavailable');
    const observed = await reader.readIdentity({ pid, signal: fixture.signal });
    expect(observed.status).toBe('FOUND'); if (observed.status !== 'FOUND') throw new Error('fixture identity unavailable');
    const readIdentity = vi.fn(reader.readIdentity);
    const provider = createWindowsProcessControl({ listenerBackend: 'netstat', identityReader: { readIdentity }, runner: request => {
      commands.push(request.command);
      if (request.command !== 'taskkill.exe') throw new Error('unexpected identity subprocess');
      return runProcessCommand(request);
    } });
    await expect(provider.terminateProcessTree({ process: observed.identity, policy: { mode: 'force' }, signal: fixture.signal }))
      .resolves.toEqual({ pid, forced: true });
    await fixture.closed; expect(fixture.error()).toBeUndefined();
    expect(readIdentity).toHaveBeenCalledExactlyOnceWith({ pid, signal: fixture.signal });
    expect(commands).toEqual(['taskkill.exe']);
  } finally { await fixture.dispose(); }
});
