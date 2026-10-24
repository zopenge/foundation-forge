import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { TextDecoder } from 'node:util';
import { expect, test } from 'vitest';
import { createNodeCommandRunner } from '@openge/forge-command-runner/node';
import { createWindowsOwnedProcessScopeProvider, createWindowsProcessControl,
  createWindowsProcessIdentityReader } from '@openge/forge-process-control-node';
import { observeLiveJobMember } from '../../process-control-node/tests/helpers/live-job-member.mjs';

test.runIf(process.platform === 'win32')('the command deadline remains active during real owned Job drain', async () => {
  const base = resolve(import.meta.dirname, '../../../.tmp/owned-scope-tests');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(resolve(base, 'deadline-'));
  let ready, active, expire, childPid, scope, output = '';
  const readyPromise = new Promise(accept => { ready = accept; });
  const activePromise = new Promise(accept => { active = accept; });
  const requests = [];
  const reader = createWindowsProcessIdentityReader(), control = createWindowsProcessControl({ listenerBackend: 'netstat' });
  const provider = createWindowsOwnedProcessScopeProvider();
  try {
    await observeLiveJobMember(() => childPid, () => active(), async () => {
      const runner = createNodeCommandRunner({ platform: 'win32',
        ownedScopeProvider: { start: (...args) => { scope = provider.start(...args); return scope; } },
        processControl: { ...control, listProcesses: async request => {
          const value = await reader.readIdentity({ pid: request.pids[0], signal: request.signal });
          return value.status === 'FOUND' ? [value.identity] : [];
        } },
        terminationPolicy: { mode: 'force' }, terminationTimeoutMs: 5000,
        identityAcquisition: { timeoutMs: 10000, pollIntervalMs: 20 },
        setTimeout: (callback, milliseconds, ...args) => {
          const timer = setTimeout(callback, milliseconds, ...args);
          if (milliseconds === 60000) expire = () => { clearTimeout(timer); callback(...args); };
          return timer;
        },
      });
      const running = runner.start({ command: process.execPath,
        args: [resolve(import.meta.dirname, '../../process-control-node/tests/fixtures/owned-drain.mjs'), 'parent', root],
        timeoutMs: 60000, ownedScope: { start: 'automatic', binding: 'deadline-during-drain' },
      }, event => {
        if (event.type === 'termination-requested') requests.push(event.reason);
        if (event.type === 'stdout') {
          output += new TextDecoder().decode(event.chunk);
          if (output.includes('\n')) { childPid = JSON.parse(output.trim()).pid; ready(); }
        }
      });
      try {
        await Promise.race([readyPromise, running.result.then(() => { throw new Error('fixture not ready'); })]);
        await writeFile(resolve(root, 'parent-exit'), 'exit');
        await Promise.race([activePromise, running.result.then(() => { throw new Error('drain not observed'); })]);
        expect(typeof expire).toBe('function'); expire();
        await writeFile(resolve(root, 'child-exit'), 'exit');
        expect(await running.result).toMatchObject({ terminationReason: 'termination-failure',
          ownedScope: { status: 'unknown', reason: 'terminated', empty: true } });
        expect(requests).toContain('timeout');
      } finally { await running.terminate(); await scope?.dispose(); }
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15000);
