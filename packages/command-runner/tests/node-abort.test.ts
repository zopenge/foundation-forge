import { getEventListeners } from 'node:events';
import { expect, it } from 'vitest';
import type { CommandEvent } from '../src/index.js';
import { command, makeRunner } from './helpers.js';

it('does not spawn for a pre-aborted signal and settles pid and identity handles', async () => {
  const controller = new AbortController();
  controller.abort();
  const events: CommandEvent[] = [];
  const running = makeRunner().runner.start(command('wait', [], { signal: controller.signal }), event => events.push(event));
  await expect(running.pid).rejects.toMatchObject({ code: 'COMMAND_ABORTED_BEFORE_START' });
  expect(await running.identity).toBeNull();
  expect(await running.result).toMatchObject({ terminationReason: 'abort', diagnostics: [expect.objectContaining({ code: 'COMMAND_ABORTED_BEFORE_START' })] });
  expect(events.some(e => e.type === 'spawned')).toBe(false);
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
});

it('aborts once with the captured identity and removes its signal listener', async () => {
  const controller = new AbortController();
  const { runner, terminations } = makeRunner();
  const running = runner.start(command('wait', [], { signal: controller.signal }));
  const identity = await running.identity;
  controller.abort();
  await running.terminate();
  const result = await running.result;
  expect(result.terminationReason).toBe('abort');
  expect(terminations).toHaveLength(1);
  expect(terminations[0]?.process).toBe(identity);
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
});

it('makes concurrent manual termination idempotent', async () => {
  const { runner, terminations } = makeRunner();
  const running = runner.start(command('wait'));
  await running.identity;
  await Promise.all([running.terminate(), running.terminate(), running.terminate('timeout')]);
  expect((await running.result).terminationReason).toBe('abort');
  expect(terminations).toHaveLength(1);
  await running.terminate();
  expect(terminations).toHaveLength(1);
});

it('prevents reentrant termination from synchronous observer callbacks', async () => {
  const controller = new AbortController();
  const { runner, terminations } = makeRunner();
  const events: CommandEvent[] = [];
  const running = runner.start(command('wait', [], { timeoutMs: 50, signal: controller.signal }), event => {
    events.push(event);
    if (event.type === 'termination-requested') controller.abort();
  });
  const result = await running.result;
  expect(result.terminationReason).toBe('timeout');
  expect(terminations).toHaveLength(1);
  expect(events.filter(event => event.type === 'termination-requested')).toHaveLength(1);
});
