import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { expect, test } from 'vitest';
import { createPosixProcessIdentityReader, createWindowsProcessIdentityReader, createLinuxOwnedProcessScopeProvider, createWindowsOwnedProcessScopeProvider,
  createWindowsProcessControl, createPosixProcessControl } from '../dist/index.js';

test.runIf(['win32', 'linux'].includes(process.platform) && process.arch === 'x64')('cleans owned descendants after the coordinator is force-killed', async () => {
  const base = resolve(import.meta.dirname, '../../../.tmp/owned-scope-tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(resolve(base, 'owner-')), marker = resolve(root, 'pid');
  const owner = spawn(process.execPath, [resolve(import.meta.dirname, 'fixtures/owned-scope-owner.mjs'), marker], { windowsHide: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const reader = process.platform === 'win32' ? createWindowsProcessIdentityReader() : createPosixProcessIdentityReader();
  try {
    await once(owner, 'message');
    let pid: number | undefined;
    const startDeadline = Date.now() + 5000;
    while (pid === undefined && Date.now() < startDeadline) {
      try { pid = Number(await readFile(marker, 'utf8')); } catch { await new Promise(accept => setTimeout(accept, 20)); }
    }
    if (!pid) throw Error('fixture writer did not start');
    const before = await reader.readIdentity({ pid }); expect(before.status).toBe('FOUND');
    const ended = once(owner, 'close'); owner.kill('SIGKILL'); await ended;
    let current = await reader.readIdentity({ pid }); const stopDeadline = Date.now() + 8000;
    while (current.status === 'FOUND' && Date.now() < stopDeadline) { await new Promise(accept => setTimeout(accept, 30)); current = await reader.readIdentity({ pid }); }
    expect(current.status).toBe('ABSENT');
  } finally { if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL'); await rm(root, { recursive: true, force: true }); }
}, 20_000);
test.runIf(['win32', 'linux'].includes(process.platform) && process.arch === 'x64')('never treats a force-killed unapproved helper as a normal close', async () => {
  const windows = process.platform === 'win32';
  const provider = windows ? createWindowsOwnedProcessScopeProvider() : createLinuxOwnedProcessScopeProvider();
  const reader = windows ? createWindowsProcessIdentityReader() : createPosixProcessIdentityReader();
  const control = windows ? createWindowsProcessControl({ listenerBackend: 'netstat' }) : createPosixProcessControl({ listenerBackend: 'lsof' });
  const scope = provider.start({ command: process.execPath, args: ['-e', 'process.exit(0)'], environment: process.env, binding: 'helper-crash', startupTimeoutMs: 5000, terminationTimeoutMs: 3000 });
  try {
    const observed = await reader.readIdentity({ pid: await scope.rootPid });
    if (observed.status !== 'FOUND') throw Error('fixture helper absent');
    await scope.bind(observed.identity);
    await control.terminateProcessTree({ process: observed.identity, policy: { mode: 'force' } });
    expect((await scope.completion).closure).toMatchObject({ status: 'unknown', reason: 'owner-lost' });
  } finally { await scope.dispose(); }
}, 20_000);
