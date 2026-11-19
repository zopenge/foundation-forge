import { expect, it } from 'vitest';
import { parseArguments } from '../src/cli-arguments.js';
const runId = '10000000-0000-4000-8000-000000000001';
it('does not expose a separate abandonment selector', () => {
  for (const args of [['retire', '--abandon-unstarted'], ['publish', '--abandon-unstarted'], ['recover', '--abandon-unstarted'],
    ['retire', '--run-id', runId, '--abandon-unstarted'],
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

it('accepts checkout discard only for an exact managed recovery request', () => {
  expect(parseArguments(['recover', '--run-id', runId, '--discard-checkout'])).toMatchObject({
    command: 'recover', runId, discardCheckout: true
  });
  for (const args of [['recover', '--discard-checkout'], ['retire', '--run-id', runId, '--discard-checkout'],
    ['recover', '--run-id', runId, '--discard-checkout', '--discard-checkout']]) {
    expect(() => parseArguments(args)).toThrowError(expect.objectContaining({ code: 'ARGUMENT_INVALID' }));
  }
});
