import { expect, it } from 'vitest';
import { parseArguments } from '../src/cli-arguments.js';
import { runRelease } from '../src/node.js';
const runId = '10000000-0000-4000-8000-000000000001';
it('accepts explicit unstarted abandonment only for an exact retirement run', () => {
  expect(parseArguments(['retire', '--run-id', runId, '--abandon-unstarted']))
    .toMatchObject({ command: 'retire', runId, abandonUnstarted: true });
  for (const args of [['retire', '--abandon-unstarted'], ['publish', '--abandon-unstarted'], ['recover', '--abandon-unstarted'],
    ['retire', '--run-id', runId, '--abandon-unstarted', '--abandon-unstarted'],
    ['retire', '--run-id', runId, '--abandon-unstarted', 'true']]) {
    expect(() => parseArguments(args)).toThrowError(expect.objectContaining({ code: 'ARGUMENT_INVALID' }));
  }
});
it('requires an explicit exact run only for retirement', () => {
  expect(parseArguments(['retire', '--run-id', runId])).toMatchObject({ command: 'retire', runId });
  for (const args of [['retire'], ['retire', '--run-id', '../file'],
    ['recover', '--run-id', runId], ['retire', '--run-id', runId, '--sha', 'a'.repeat(40)]]) {
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
});
