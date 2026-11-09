import { expect, it } from 'vitest';
import { parseArguments } from '../src/cli-arguments.js';
import { runRelease } from '../src/node.js';
const runId = '10000000-0000-4000-8000-000000000001';
it('accepts explicit unstarted abandonment only for an exact retirement run', () => {
  expect(parseArguments(['retire', '--run-id', runId, '--abandon-unstarted']))
    .toMatchObject({ command: 'retire', runId, abandonUnstarted: true });
  for (const args of [['retire', '--abandon-unstarted'], ['publish', '--abandon-unstarted'], ['recover', '--abandon-unstarted'],
    ['retire', '--run-id', runId, '--abandon-unstarted', '--abandon-unstarted'],
    ['retire', '--run-id', runId, '--abandon-unstarted', 'true'],
    ['retire', '--run-id', runId, '--abandon-unstarted', '--confirm-origin', 'a'.repeat(64)]]) {
    expect(() => parseArguments(args)).toThrowError(expect.objectContaining({ code: 'ARGUMENT_INVALID' }));
  }
});
it('requires explicit exact run and origin acknowledgement only for retirement', () => {
  expect(parseArguments(['retire', '--run-id', runId, '--confirm-origin', 'a'.repeat(64)])).toMatchObject({ command: 'retire', runId, confirmOrigin: 'a'.repeat(64) });
  for (const args of [['retire'], ['retire', '--run-id', '../file'], ['retire', '--run-id', runId, '--confirm-origin', 'yes'],
    ['recover', '--run-id', runId], ['publish', '--confirm-origin', 'a'.repeat(64)], ['retire', '--run-id', runId, '--sha', 'a'.repeat(40)]]) {
    expect(() => parseArguments(args)).toThrowError(expect.objectContaining({ code: 'ARGUMENT_INVALID' }));
  }
});

it('rejects the abandonment option at the public SDK boundary before reading local state for another command', async () => {
  for (const command of ['check', 'publish', 'status', 'verify', 'recover', 'login'] as const) {
    expect(await runRelease({ command, cwd: import.meta.dirname, abandonUnstarted: true }))
      .toMatchObject({ ok: false, error: { code: 'ARGUMENT_INVALID' } });
  }
  const invalid = { command: 'retire' as const, cwd: import.meta.dirname, runId, abandonUnstarted: true };
  Reflect.set(invalid, 'abandonUnstarted', 'yes');
  expect(await runRelease(invalid)).toMatchObject({ ok: false, error: { code: 'ARGUMENT_INVALID' } });
  expect(await runRelease({ command: 'retire', cwd: import.meta.dirname, runId, abandonUnstarted: true, confirmOrigin: 'a'.repeat(64) }))
    .toMatchObject({ ok: false, error: { code: 'ARGUMENT_INVALID' } });
});
