import { expect, test } from 'vitest';
import type { ProcessIdentityReader, ReadProcessIdentityResult } from '@openge/forge-process-control';
import { readIdentityPair } from './helpers/identity-read-pair.js';
import { startIdentityCommand } from './helpers/identity-command.js';
import { processControlErrorCodes } from '@openge/forge-process-control';

const found: ReadProcessIdentityResult = { status: 'FOUND', identity: { pid: 42, startToken: 'fixture' } };
function deferred() {
  let accept: ((result: ReadProcessIdentityResult) => void) | undefined;
  const promise = new Promise<ReadProcessIdentityResult>(resolve => { accept = resolve; });
  return { promise, resolve: () => { if (!accept) throw new Error('FIXTURE_NOT_READY'); accept(found); } };
}
test('starts two independent observations before awaiting either, within one cancellation domain', async context => {
  const first = deferred(), second = deferred(), requests: AbortSignal[] = [];
  const reader: ProcessIdentityReader = { readIdentity: request => {
    if (request.signal) requests.push(request.signal);
    return requests.length === 1 ? first.promise : second.promise;
  } };
  const pair = readIdentityPair(reader, 42, context.signal);
  try { expect(requests).toEqual([context.signal, context.signal]); }
  finally { first.resolve(); second.resolve(); await pair; }
  await expect(pair).resolves.toEqual([found, found]);
});
test.for(['async', 'sync'] as const)('drains the other observation before exposing the original %s failure', async (kind, context) => {
  const second = deferred(), failure = new Error('FIXTURE_IDENTITY_FAILED'); let calls = 0, settled = false;
  const reader: ProcessIdentityReader = { readIdentity: () => {
    if (++calls !== 1) return second.promise;
    if (kind === 'sync') throw failure;
    return Promise.reject(failure);
  } };
  const observed = readIdentityPair(reader, 42, context.signal).then(
    () => { settled = true; return undefined; }, error => { settled = true; return error; });
  try { await Promise.resolve(); await Promise.resolve(); expect(calls).toBe(2); expect(settled).toBe(false); }
  finally { second.resolve(); await observed; }
  await expect(observed).resolves.toBe(failure);
});
test('cancels both observations through the original caller signal without retrying', async () => {
  const controller = new AbortController(), failure = new Error('FIXTURE_ABORTED'); let started = 0, stopped = 0;
  const reader: ProcessIdentityReader = { readIdentity: request => new Promise((_accept, reject) => {
    started++; const signal = request.signal;
    if (!signal) throw new Error('FIXTURE_SIGNAL_REQUIRED');
    signal.addEventListener('abort', () => { stopped++; reject(failure); }, { once: true });
  }) };
  const result = readIdentityPair(reader, 42, controller.signal); controller.abort();
  await expect(result).rejects.toBe(failure); expect(started).toBe(2); expect(stopped).toBe(2);
});
test('does not settle a cancelled real command before its child close barrier', async context => {
  const controller = new AbortController(), signal = AbortSignal.any([context.signal, controller.signal]);
  const { child, completion, events } = startIdentityCommand({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], signal });
  let closed = false;
  const closure = new Promise<void>(accept => child.once('close', () => { closed = true; accept(); }));
  child.once('spawn', () => { controller.abort(); });
  const observed = completion.then(() => undefined, error => error);
  try {
    expect(await observed).toMatchObject({ code: processControlErrorCodes.operationAborted });
    expect(closed).toBe(true);
    const phases = events.map(event => event.phase);
    expect(phases[0]).toBe('spawn');
    expect(phases).toEqual(expect.arrayContaining(['callback', 'exit', 'close']));
    expect(phases.at(-1)).toBe('close');
  } finally { controller.abort(); await closure; await observed; }
});
