import { expect, it } from 'vitest';
import { createNodeCommandRunner, type NodeCommandRunnerOptions } from '../src/node.js';
import { makeRunner } from './helpers.js';

it.each([0, -1, NaN, Infinity, 1.5])('rejects invalid termination budget %s synchronously', terminationTimeoutMs => {
  expect(() => makeRunner({ terminationTimeoutMs })).toThrowError(expect.objectContaining({ code: 'COMMAND_INVALID_TIMEOUT' }));
});
it('requires the termination budget to cover the explicit grace period', () => {
  expect(() => makeRunner({ terminationTimeoutMs: 20, terminationPolicy: { mode: 'graceful-then-force', gracePeriodMs: 100, pollIntervalMs: 10 } })).toThrowError(expect.objectContaining({ code: 'COMMAND_INVALID_TIMEOUT' }));
});
it('rejects an absent explicit Provider with a structured error', () => {
  const options = { platform: 'win32', terminationTimeoutMs: 100, terminationPolicy: { mode: 'force' }, identityAcquisition: { timeoutMs: 100, pollIntervalMs: 10 } } as NodeCommandRunnerOptions;
  expect(() => createNodeCommandRunner(options)).toThrowError(expect.objectContaining({ code: 'COMMAND_INVALID_SPEC' }));
});

it('accepts the existing Process Control zero-grace termination policy', () => {
  expect(() => makeRunner({ terminationPolicy: { mode: 'graceful-then-force', gracePeriodMs: 0, pollIntervalMs: 10 } })).not.toThrow();
});
