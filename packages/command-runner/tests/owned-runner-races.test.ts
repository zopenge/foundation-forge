import { expect, test, vi } from 'vitest';
import type { OwnedProcessCompletion, OwnedProcessOutput, OwnedProcessScopeProvider, ProcessControlProvider, ProcessDescriptor } from '@openge/forge-process-control';
import { createNodeCommandRunner, type NodeCommandRunnerOptions } from '../src/node.js';
import type { CommandEvent, CommandSpec } from '../src/index.js';

function harness(overrides: Partial<NodeCommandRunnerOptions> = {}, completeOnTerminate = true) {
  let complete!: (value: OwnedProcessCompletion) => void, output: ((value: OwnedProcessOutput) => void) | undefined;
  const identity = { pid: 123, startToken: 'fixture' };
  const closure = { status: 'unknown' as const, reason: 'terminated' as const, scopeId: 'scope', binding: 'race', observedAt: new Date().toISOString(), empty: true };
  const completion = new Promise<OwnedProcessCompletion>(resolve => { complete = resolve; });
  const terminate = vi.fn(async () => { if (completeOnTerminate) complete({ exitCode: null, signal: null, closure }); return closure; });
  const authorize = vi.fn(async () => {}), bind = vi.fn(async () => {});
  const ownedScopeProvider: OwnedProcessScopeProvider = { start: vi.fn((_request, callback) => { output = callback; return { scopeId: 'scope', rootPid: Promise.resolve(123), completion, terminate, bind, authorize, dispose: async () => {} }; }) };
  const processControl: ProcessControlProvider = { listProcesses: async () => [identity], listTcpListeners: async () => [], terminateProcess: async () => { throw Error('unexpected'); }, terminateProcessTree: async () => { throw Error('unexpected'); } };
  const options: NodeCommandRunnerOptions = { platform: 'win32', processControl, ownedScopeProvider, terminationPolicy: { mode: 'force' }, terminationTimeoutMs: 50, identityAcquisition: { timeoutMs: 100, pollIntervalMs: 5 }, ...overrides };
  const spec: CommandSpec = { command: 'synthetic-command', ownedScope: { start: 'manual', binding: 'race' }, timeoutMs: 50 };
  return { runner: createNodeCommandRunner(options), options, spec, ownedScopeProvider, terminate, authorize, bind, output: (chunk: Uint8Array) => output?.({ stream: 'stdout', chunk }) };
}
test('rejects missing providers and unsupported policies without starting any scope', () => {
  const f = harness(); const { ownedScopeProvider: omitted, ...ordinary } = f.options; expect(omitted).toBe(f.ownedScopeProvider);
  expect(() => createNodeCommandRunner(ordinary).start(f.spec)).toThrowError(expect.objectContaining({ code: 'COMMAND_SCOPE_UNSUPPORTED' }));
  expect(() => createNodeCommandRunner({ ...f.options, terminationPolicy: { mode: 'graceful' } }).start(f.spec)).toThrowError(expect.objectContaining({ code: 'COMMAND_SCOPE_UNSUPPORTED' }));
  expect(f.ownedScopeProvider.start).not.toHaveBeenCalled();
});
test('an observer failure at scope-ready prevents automatic authorization', async () => {
  const f = harness();
  const result = await f.runner.run({ ...f.spec, ownedScope: { start: 'automatic', binding: 'race' } }, event => { if (event.type === 'scope-ready') throw Error('observer failed'); });
  expect(result.terminationReason).toBe('termination-failure'); expect(f.authorize).not.toHaveBeenCalled();
  expect(result.diagnostics.map(value => value.code)).toContain('COMMAND_OBSERVER_FAILED');
});
test('manual waiting times out and never authorizes', async () => {
  const f = harness(), result = await f.runner.start(f.spec).result;
  expect(result).toMatchObject({ terminationReason: 'termination-failure', ownedScope: { status: 'unknown' } });
  expect(f.terminate).toHaveBeenCalledTimes(1); expect(f.authorize).not.toHaveBeenCalled();
});
test('capture overflow cancels through scope ownership with the original byte bound', async () => {
  const f = harness(), running = f.runner.start({ ...f.spec, output: { mode: 'capture', maxBytesPerStream: 2, overflow: 'fail' } });
  await running.identity; f.output(new Uint8Array([1, 2, 3]));
  expect(await running.result).toMatchObject({ terminationReason: 'termination-failure', stdout: new Uint8Array([1, 2]), stdoutTruncated: true });
  expect(f.terminate).toHaveBeenCalledTimes(1);
});
test('a provider that never completes cannot leave the runner pending indefinitely', async () => {
  const f = harness({}, false), running = f.runner.start(f.spec);
  await running.terminate();
  const result = await running.result; expect(result.terminationReason).toBe('termination-failure');
  expect(result.diagnostics.map(value => value.code)).toContain('COMMAND_SCOPE_UNKNOWN');
});
test('late identity responses after cancellation cannot bind or authorize', async () => {
  let resolveLookup!: (value: readonly ProcessDescriptor[]) => void;
  const f = harness();
  const runner = createNodeCommandRunner({ ...f.options, processControl: { ...f.options.processControl, listProcesses: () => new Promise(resolve => { resolveLookup = resolve; }) } });
  const events: CommandEvent[] = [], running = runner.start(f.spec, event => events.push(event));
  await running.pid; await Promise.resolve(); await running.terminate(); await running.result;
  resolveLookup([{ pid: 123, startToken: 'fixture' }]); await Promise.resolve(); await Promise.resolve();
  expect(f.bind).not.toHaveBeenCalled(); expect(f.authorize).not.toHaveBeenCalled(); expect(events.some(event => event.type === 'scope-ready')).toBe(false);
});
test('ignores a rootPid failure delivered after the bounded result was frozen', async () => {
  const f = harness({}, false), implementation = vi.mocked(f.ownedScopeProvider.start).getMockImplementation();
  if (!implementation) throw Error('fixture provider missing');
  let rejectRoot!: (error: unknown) => void;
  const rootPid = new Promise<number>((_accept, reject) => { rejectRoot = reject; });
  vi.mocked(f.ownedScopeProvider.start).mockImplementation((...args) => ({ ...implementation(...args), rootPid }));
  const running = f.runner.start(f.spec), result = await running.result, before = [...result.diagnostics];
  expect(Object.isFrozen(result.diagnostics)).toBe(true);
  rejectRoot(Error('late startup failure'));
  await new Promise(accept => setTimeout(accept, 20));
  expect(result.diagnostics).toEqual(before);
});
