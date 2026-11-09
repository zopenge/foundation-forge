import process from 'node:process';
import { inspect } from 'node:util';
import { expect, it, vi } from 'vitest';
import { command, decode, makeRunner } from './helpers.js';

it('retains the exact first N bytes separately, including partial UTF-8 sequences', async () => {
  const result = await makeRunner().runner.run(command('bytes', [], { output: { mode: 'capture', maxBytesPerStream: 4, overflow: 'truncate' } }));
  expect(result.stdout).toEqual(new Uint8Array([228, 189, 160, 229]));
  expect(decode(result.stderr)).toBe('abcd');
  expect(result.stdoutTruncated).toBe(true);
  expect(result.stderrTruncated).toBe(true);
  expect(result.terminationReason).toBe('exit');
});

it('reports overflow failure and bounds both retained streams', async ({ signal, onTestFinished }) => {
  const { runner, terminations } = makeRunner();
  const running = runner.start(command('bytes-wait', [], { signal, output: { mode: 'capture', maxBytesPerStream: 2, overflow: 'fail' } }));
  let pid: number | undefined;
  let closing: Promise<void> | undefined;
  const cleanup = () => closing ??= (async () => {
    await running.terminate(); await running.result;
    const finishedPid = pid;
    if (finishedPid !== undefined) await vi.waitFor(() => {
      expect(() => process.kill(finishedPid, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }));
    }, { timeout: 1000, interval: 10 });
  })();
  onTestFinished(cleanup);
  try {
    pid = await running.pid;
    const result = await running.result;
    expect(result.terminationReason, inspect(result, { depth: 4, maxArrayLength: 16, maxStringLength: 500 })).toBe('output-overflow');
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'COMMAND_OUTPUT_OVERFLOW' }));
    expect(result.stdout?.byteLength).toBeLessThanOrEqual(2);
    expect(result.stderr?.byteLength).toBeLessThanOrEqual(2);
    expect(terminations).toHaveLength(1);
  } finally {
    await cleanup();
  }
});

it('isolates captured bytes from observer mutation', async () => {
  const result = await makeRunner().runner.run(command('output', [], { output: { mode: 'capture', maxBytesPerStream: 100, overflow: 'truncate' } }), event => {
    if (event.type === 'stdout') event.chunk.fill(0);
  });
  expect(decode(result.stdout)).toBe('alpha β');
});
