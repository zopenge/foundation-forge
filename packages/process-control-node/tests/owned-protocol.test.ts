import { expect, test } from 'vitest';
import { controlLimit, frame, readFrame, supervisorEnvironment, validateLaunch } from '../src/owned-scope/protocol.js';

const key = { scopeId: 'scope', binding: 'command', nonce: 'private' };
test('binds each control frame to the exact scope and sequence', () => {
  const value = frame(key, 1, 'bind', undefined, 1);
  expect(readFrame(value, key, 1)).toEqual(value);
  for (const patch of [{ nonce: 'other' }, { binding: 'other' }, { scopeId: 'other' }, { sequence: 2 }, { version: 2 }, { id: 0 }, { payload: 'x'.repeat(controlLimit) }]) {
    expect(() => readFrame({ ...value, ...patch }, key, 1)).toThrowError(expect.objectContaining({ code: 'PROCESS_SCOPE_BINDING' }));
  }
  expect(() => readFrame(value, key, 2)).toThrow();
});
test('rejects invalid or oversized launch inputs before job execution', () => {
  const request = { command: 'node', environment: {}, binding: 'job', startupTimeoutMs: 1000, terminationTimeoutMs: 1000 };
  expect(() => validateLaunch(request)).not.toThrow();
  for (const patch of [{ command: 'bad\0' }, { binding: 'space binding' }, { startupTimeoutMs: Infinity }, { environment: { NODE_OPTIONS: 'x'.repeat(1_048_576) } }]) {
    expect(() => validateLaunch({ ...request, ...patch })).toThrowError(expect.objectContaining({ code: 'PROCESS_SCOPE_INVALID_INPUT' }));
  }
  expect(supervisorEnvironment({ node_options: 'forbidden', Node_Path: 'forbidden', LD_PRELOAD: 'forbidden', DYLD_INSERT_LIBRARIES: 'forbidden', PATH: 'kept' })).toEqual({ PATH: 'kept' });
});
