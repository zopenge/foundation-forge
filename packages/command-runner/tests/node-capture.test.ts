import { expect, it } from 'vitest';
import { command, decode, makeRunner } from './helpers.js';

it('retains the exact first N bytes separately, including partial UTF-8 sequences', async () => {
  const result = await makeRunner().runner.run(command('bytes', [], { output: { mode: 'capture', maxBytesPerStream: 4, overflow: 'truncate' } }));
  expect(result.stdout).toEqual(new Uint8Array([228, 189, 160, 229]));
  expect(decode(result.stderr)).toBe('abcd');
  expect(result.stdoutTruncated).toBe(true);
  expect(result.stderrTruncated).toBe(true);
  expect(result.terminationReason).toBe('exit');
});

it('reports overflow failure and bounds both retained streams', async () => {
  const result = await makeRunner().runner.run(command('bytes', [], { output: { mode: 'capture', maxBytesPerStream: 2, overflow: 'fail' } }));
  expect(result.terminationReason).toBe('output-overflow');
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'COMMAND_OUTPUT_OVERFLOW' }));
  expect(result.stdout?.byteLength).toBeLessThanOrEqual(2);
  expect(result.stderr?.byteLength).toBeLessThanOrEqual(2);
});

it('isolates captured bytes from observer mutation', async () => {
  const result = await makeRunner().runner.run(command('output', [], { output: { mode: 'capture', maxBytesPerStream: 100, overflow: 'truncate' } }), event => {
    if (event.type === 'stdout') event.chunk.fill(0);
  });
  expect(decode(result.stdout)).toBe('alpha β');
});
