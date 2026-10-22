import { expect, test, vi } from 'vitest';
import type { OwnedProcessCompletion, OwnedProcessLaunchRequest, OwnedProcessScopeProvider, ProcessIdentity } from '@openge/forge-process-control';
import { createNodeCommandRunner } from '../src/node.js';
import type { CommandEvent, CommandSpec } from '../src/index.js';

const identity: ProcessIdentity = { pid: 123, startToken: 'synthetic-instance' };
function fixture(identified = true) {
  let complete!: (value: OwnedProcessCompletion) => void, request: OwnedProcessLaunchRequest;
  const completion = new Promise<OwnedProcessCompletion>(resolve => { complete = resolve; });
  const authorize = vi.fn(async () => { complete({ exitCode: 0, signal: null, closure: { scopeId: 'scope', binding: request.binding, status: 'closed', reason: 'normal', empty: true, rootIdentity: identity, observedAt: new Date().toISOString() } }); });
  const terminate = vi.fn(async () => {
    const closure = { scopeId: 'scope', binding: request.binding, status: 'unknown' as const, reason: 'terminated' as const, empty: true, observedAt: new Date().toISOString() };
    complete({ exitCode: null, signal: null, closure }); return closure;
  });
  const bind = vi.fn(async () => {});
  const provider: OwnedProcessScopeProvider = { start: vi.fn(value => { request = value; return { scopeId: 'scope', rootPid: Promise.resolve(identity.pid), completion, authorize, terminate, bind, dispose: async () => {} }; }) };
  const control = { listProcesses: async () => identified ? [identity] : [], listTcpListeners: async () => [], terminateProcess: vi.fn(), terminateProcessTree: vi.fn() };
  const runner = createNodeCommandRunner({ platform: 'win32', ownedScopeProvider: provider, processControl: control, terminationPolicy: { mode: 'force' }, terminationTimeoutMs: 100, identityAcquisition: { timeoutMs: 30, pollIntervalMs: 5 } });
  const spec: CommandSpec = { command: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 1000, ownedScope: { start: 'manual', binding: 'bound-command' } };
  return { runner, spec, provider, authorize, terminate, bind, control };
}
test('rejects manual run and invalid manual input before calling a provider', () => {
  const f = fixture();
  expect(() => f.runner.run(f.spec)).toThrowError(expect.objectContaining({ code: 'COMMAND_INVALID_SPEC' }));
  const { timeoutMs: omitted, ...withoutTimeout } = f.spec; expect(omitted).toBe(1000);
  expect(() => f.runner.start(withoutTimeout)).toThrow();
  expect(() => f.runner.start({ ...f.spec, ownedScope: { start: 'manual', binding: 'invalid binding' } })).toThrow();
  expect(f.provider.start).not.toHaveBeenCalled();
});
test('binds before scope-ready and waits for exactly one explicit authorization', async () => {
  const f = fixture(), events: CommandEvent[] = [];
  let ready!: () => void; const scopeReady = new Promise<void>(resolve => { ready = resolve; });
  const running = f.runner.start(f.spec, event => { events.push(event); if (event.type === 'scope-ready') { expect(f.bind).toHaveBeenCalledWith(identity, expect.anything()); ready(); } });
  await scopeReady; expect(f.authorize).not.toHaveBeenCalled();
  if (!running.authorizeStart) throw Error('manual gate missing');
  await Promise.all([running.authorizeStart(), running.authorizeStart()]);
  expect(f.authorize).toHaveBeenCalledTimes(1);
  expect(await running.result).toMatchObject({ terminationReason: 'exit', ownedScope: { status: 'closed', binding: 'bound-command' } });
  expect(events.map(event => event.type)).toEqual(['spawned', 'identified', 'scope-ready', 'exited']);
  await expect(running.authorizeStart()).rejects.toThrow();
});
test('cancellation before authorization never calls the job and closes through the scope', async () => {
  const f = fixture(), controller = new AbortController();
  const running = f.runner.start({ ...f.spec, signal: controller.signal }); await running.identity;
  controller.abort();
  expect(await running.result).toMatchObject({ terminationReason: 'termination-failure', ownedScope: { status: 'unknown' } });
  expect(f.authorize).not.toHaveBeenCalled(); expect(f.terminate).toHaveBeenCalledTimes(1); expect(f.control.terminateProcessTree).not.toHaveBeenCalled();
});
test('identity failure never authorizes a scope and retains unknown closure', async () => {
  const f = fixture(false), running = f.runner.start(f.spec);
  expect(await running.result).toMatchObject({ terminationReason: 'termination-failure', ownedScope: { status: 'unknown' } });
  expect(f.authorize).not.toHaveBeenCalled(); expect(f.terminate).toHaveBeenCalledTimes(1);
});
