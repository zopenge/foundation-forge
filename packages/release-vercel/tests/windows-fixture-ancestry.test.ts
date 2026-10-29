import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import * as batch from './helpers/windows-fixture-ancestry.js';
import { identityReader } from '../src/node/process-identities.js';

const owner = { pid: 10, startToken: 'owner' };
interface Row { ProcessId: number; ParentProcessId: number; CreationDate: string }
const rows = (): [Row, Row, Row] => [
  { ProcessId: 10, ParentProcessId: 1, CreationDate: 'owner' },
  { ProcessId: 30, ParentProcessId: 20, CreationDate: 'leaf' },
  { ProcessId: 20, ParentProcessId: 10, CreationDate: 'parent' },
];
const capture = (...args: Parameters<typeof batch.captureWindowsFixtureAncestry>) => {
  expect(batch.captureWindowsFixtureAncestry).toBeTypeOf('function');
  return batch.captureWindowsFixtureAncestry(...args);
};

it('captures and rechecks a real ancestry through one bounded exact-PID command', async () => {
  const signal = AbortSignal.timeout(10_000);
  const query = vi.fn(async (script: string, observedSignal: AbortSignal) => {
    expect(observedSignal).toBe(signal);
    expect(script).toContain('Get-CimInstance Win32_Process -Filter');
    expect(script).toContain('ProcessId=');
    expect(script).not.toContain('CommandLine');
    return JSON.stringify({ initial: rows(), current: rows() });
  });
  expect(await capture(owner, 30, { signal, query })).toEqual([
    { pid: 30, startToken: 'leaf' }, { pid: 20, startToken: 'parent' },
  ]);
  expect(query).toHaveBeenCalledTimes(1);
});

it.runIf(process.platform === 'win32')('binds a live owned child and its parent with the real filtered batch', async () => {
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

it.each(['owner', 'leaf', 'parent-identity', 'parent', 'missing', 'duplicate', 'foreign', 'cycle'] as const)('rejects incomplete or changed batch evidence: %s', async mode => {
  const initial = rows(), current = rows();
  if (mode === 'owner') current[0].CreationDate = 'replacement';
  if (mode === 'leaf') current[1].CreationDate = 'replacement';
  if (mode === 'parent-identity') current[2].CreationDate = 'replacement';
  if (mode === 'parent') current[1].ParentProcessId = 10;
  if (mode === 'missing') current.pop();
  if (mode === 'duplicate') initial.push({ ...initial[1] });
  if (mode === 'foreign') {
    const foreign = { ProcessId: 40, ParentProcessId: 10, CreationDate: 'foreign' };
    initial.push(foreign); current.push({ ...foreign });
  }
  if (mode === 'cycle') initial[2].ParentProcessId = 30;
  await expect(capture(owner, 30, { query: async () => JSON.stringify({ initial, current }) })).rejects.toThrow('FIXTURE_ANCESTRY');
});

it('rejects a pre-aborted request before starting a command and propagates query failure', async () => {
  const control = new AbortController(); control.abort();
  const query = vi.fn(async () => '');
  await expect(capture(owner, 30, { signal: control.signal, query })).rejects.toThrow();
  expect(query).not.toHaveBeenCalled();
  const failure = new Error('batch query failed');
  await expect(capture(owner, 30, { query: async () => { throw failure; } })).rejects.toMatchObject({ cause: failure });
});
