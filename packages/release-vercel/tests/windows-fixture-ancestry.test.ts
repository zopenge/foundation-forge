import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import type { ProcessDescriptor } from '@openge/forge-process-control';
import * as batch from './helpers/windows-fixture-ancestry.js';
import { identityReader } from '../src/node/process-identities.js';

const owner = { pid: 10, startToken: 'owner' };
interface Row extends ProcessDescriptor { parentPid: number; startToken: string }
const rows = (): [Row, Row, Row] => [
  { pid: 10, parentPid: 1, startToken: 'owner' },
  { pid: 30, parentPid: 20, startToken: 'leaf' },
  { pid: 20, parentPid: 10, startToken: 'parent' },
];
const capture = (...args: Parameters<typeof batch.captureWindowsFixtureAncestry>) => {
  expect(batch.captureWindowsFixtureAncestry).toBeTypeOf('function');
  return batch.captureWindowsFixtureAncestry(...args);
};

it('captures only discovered exact PIDs and freshly rechecks the complete bounded ancestry', async () => {
  const signal = AbortSignal.timeout(10_000);
  const query = vi.fn(async (pids: readonly number[], observedSignal: AbortSignal) => {
    expect(observedSignal).toBe(signal);
    return rows().filter(row => pids.includes(row.pid));
  });
  expect(await capture(owner, 30, { signal, query })).toEqual([
    { pid: 30, startToken: 'leaf' }, { pid: 20, startToken: 'parent' },
  ]);
  expect(query.mock.calls.map(([pids]) => pids)).toEqual([[10, 30], [20], [10, 30, 20]]);
});

it.runIf(process.platform === 'win32')('binds a live owned child and its parent with fresh native descriptors', async () => {
  const child = spawn(process.execPath, ['-e', 'process.send("ready");setInterval(()=>{},1000)'],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  const closed = new Promise<void>(accept => child.once('close', () => accept()));
  try {
    await once(child, 'message', { signal: AbortSignal.timeout(10_000) });
    if (!child.pid) throw new Error('fixture child missing');
    const reader = identityReader(), current = await reader.readIdentity({ pid: process.pid });
    if (current.status !== 'FOUND') throw new Error('fixture owner missing');
    const observed = await reader.readIdentity({ pid: child.pid });
    if (observed.status !== 'FOUND') throw new Error('fixture child missing');
    expect(await capture(current.identity, child.pid)).toEqual([observed.identity]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  }
});

it.each(['owner', 'leaf', 'parent-identity', 'parent', 'missing', 'duplicate', 'foreign', 'cycle'] as const)('rejects incomplete or changed exact-PID evidence: %s', async mode => {
  const initial = rows(), current = rows();
  if (mode === 'owner') current[0].startToken = 'replacement';
  if (mode === 'leaf') current[1].startToken = 'replacement';
  if (mode === 'parent-identity') current[2].startToken = 'replacement';
  if (mode === 'parent') current[1].parentPid = 10;
  if (mode === 'missing') current.pop();
  if (mode === 'cycle') initial[2].parentPid = 30;
  const query = async (pids: readonly number[]) => {
    const result = (pids.length === 3 ? current : initial).filter(row => pids.includes(row.pid));
    if (mode === 'duplicate') result.push({ ...initial[1] });
    if (mode === 'foreign') result.push({ pid: 40, parentPid: 10, startToken: 'foreign' });
    return result;
  };
  await expect(capture(owner, 30, { query })).rejects.toThrow('FIXTURE_ANCESTRY');
});

it('rejects a pre-aborted request before querying a PID and propagates query failure', async () => {
  const control = new AbortController(); control.abort();
  const query = vi.fn(async () => []);
  await expect(capture(owner, 30, { signal: control.signal, query })).rejects.toThrow();
  expect(query).not.toHaveBeenCalled();
  const failure = new Error('descriptor query failed');
  await expect(capture(owner, 30, { query: async () => { throw failure; } })).rejects.toMatchObject({ cause: failure });
});
