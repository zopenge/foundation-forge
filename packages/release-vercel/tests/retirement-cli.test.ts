import { expect, it } from 'vitest';
import { parseArguments } from '../src/cli-arguments.js';
const runId = '10000000-0000-4000-8000-000000000001';
it('requires explicit exact run and origin acknowledgement only for retirement', () => {
  expect(parseArguments(['retire', '--run-id', runId, '--confirm-origin', 'a'.repeat(64)])).toMatchObject({ command: 'retire', runId, confirmOrigin: 'a'.repeat(64) });
  for (const args of [['retire'], ['retire', '--run-id', '../file'], ['retire', '--run-id', runId, '--confirm-origin', 'yes'],
    ['recover', '--run-id', runId], ['publish', '--confirm-origin', 'a'.repeat(64)], ['retire', '--run-id', runId, '--sha', 'a'.repeat(40)]]) {
    expect(() => parseArguments(args)).toThrowError(expect.objectContaining({ code: 'ARGUMENT_INVALID' }));
  }
});
