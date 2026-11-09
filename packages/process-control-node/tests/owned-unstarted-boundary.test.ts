import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, test, vi } from 'vitest';
import { ProcessControlError } from '@openge/forge-process-control';
import { frame, type ScopeKey } from '../src/owned-scope/protocol.js';
import { startSupervisor } from '../src/owned-scope/supervisor.js';

const hooks = vi.hoisted(() => ({ spawn: undefined as undefined | ((args: string[]) => unknown) }));
vi.mock('node:child_process', () => ({ spawn: (_command: string, args: string[]) => hooks.spawn?.(args) }));
afterEach(() => { hooks.spawn = undefined; vi.useRealTimers(); });

// 完整替代OS边界，只验证控制流；fake empty/identity不构成真实进程关闭证据。
class Helper extends EventEmitter {
  readonly pid = 1234;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  connected = true;
  exitCode: number | null = null;
  signalCode: string | null = null;
  kills = 0;
  starts = 0;
  autoClose = false;
  sequence = 1;
  constructor(readonly key: ScopeKey) { super(); }
  send(value: { type: string; id: number }, callback: (error?: Error) => void) {
    if (value.type === 'start') this.starts++;
    queueMicrotask(() => { this.emit('message', frame(this.key, ++this.sequence, 'response', { ok: true }, value.id)); callback(); });
  }
  kill() { this.kills++; if (this.autoClose) queueMicrotask(() => this.close()); return true; }
  close() { this.signalCode = 'SIGKILL'; this.emit('close', null, 'SIGKILL'); }
  disconnect() { this.connected = false; }
  unref() { return this; }
}
const request = { command: 'must-not-run', environment: {}, binding: 'unstarted-boundary', startupTimeoutMs: 1000, terminationTimeoutMs: 50 };
const setup = (ready = false) => {
  let child: Helper | undefined;
  hooks.spawn = args => {
    child = new Helper({ scopeId: args[2] ?? '', binding: args[3] ?? '', nonce: args[4] ?? '' });
    const selected = child;
    queueMicrotask(() => { selected.emit('spawn'); if (ready) selected.emit('message', frame(selected.key, 1, 'ready')); });
    return child;
  };
  return () => { if (!child) throw Error('helper was not created'); return child; };
};

test.each(['closed', 'close-timeout', 'dispose-failed'] as const)('an unbound attachment failure requires helper close and successful disposal for empty evidence: %s', async outcome => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const child = setup(); let empties = 0, disposed = 0, completed = false;
  const failure = new ProcessControlError('PROCESS_SCOPE_UNKNOWN', { stage: 'ASSIGN_JOB', nativeCode: 5 });
  const scope = startSupervisor(request, 'win32', async () => ({
    attach: async () => { throw failure; }, bind: async () => {}, force: async () => {},
    empty: async () => { empties++; return true; },
    dispose: async () => { disposed++; if (outcome === 'dispose-failed') throw Error('fixture disposal failure'); },
  }));
  void scope.completion.then(() => { completed = true; });
  try {
    await expect(scope.rootPid).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(0);
    expect(child().kills).toBe(1); expect(child().starts).toBe(0); expect(empties).toBe(0); expect(completed).toBe(false);
    if (outcome === 'close-timeout') await vi.advanceTimersByTimeAsync(1000); else child().close();
    const result = await scope.completion;
    expect(result.closure).toMatchObject({ status: 'unknown', reason: 'provider-failed' });
    expect(result.closure).not.toHaveProperty('rootIdentity');
    expect(result.closure.empty).toBe(outcome === 'closed' ? true : undefined);
    expect(disposed).toBe(1);
  } finally { child().close(); await scope.dispose(); }
});

test('a failure after authorization retains the bound identity even if the backend is empty', async () => {
  const child = setup(true), identity = { pid: 1234, startToken: 'synthetic-instance' };
  const scope = startSupervisor(request, 'win32', async () => ({ attach: async () => {}, bind: async () => {},
    force: async () => {}, empty: async () => true, dispose: async () => {} }));
  try {
    expect(await scope.rootPid).toBe(identity.pid); child().autoClose = true;
    await scope.bind(identity); await scope.authorize();
    child().emit('message', { malformed: true });
    expect((await scope.completion).closure).toMatchObject({ status: 'unknown', reason: 'provider-failed', empty: true, rootIdentity: identity });
    expect(child().starts).toBe(1);
  } finally { child().autoClose = true; await scope.dispose(); }
});
