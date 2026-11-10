import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { TextDecoder } from 'node:util';
import { expect, test } from 'vitest';
import { createNodeCommandRunner } from '@openge/forge-command-runner/node';
import { createWindowsOwnedProcessScopeProvider, createWindowsProcessControl,
  createWindowsNativeProcessIdentityReader } from '@openge/forge-process-control-node';
import { observeLiveJobMember } from '../../process-control-node/tests/helpers/live-job-member.mjs';

const prematureResult = (message, result) => new Error(message, { cause: {
  terminationReason: result.terminationReason, durationMs: result.durationMs,
  ownedScope: result.ownedScope, diagnostics: result.diagnostics,
} });

test.runIf(process.platform === 'win32')('the command deadline remains active during real owned Job drain', async () => {
  const base = resolve(import.meta.dirname, '../../../.tmp/owned-scope-tests');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(resolve(base, 'deadline-'));
  let ready, active, expire, childPid, scope, output = '';
  const readyPromise = new Promise(accept => { ready = accept; });
  const activePromise = new Promise(accept => { active = accept; });
  const requests = [];
  // 身份读取与命令式 reader 的一致性由独立真实用例验证；本项专注于真实 Job 的期限与收尾。
  const reader = createWindowsNativeProcessIdentityReader(), control = createWindowsProcessControl({ listenerBackend: 'netstat', identityReader: reader });
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
        await Promise.race([readyPromise, running.result.then(result => { throw prematureResult('fixture not ready', result); })]);
        await writeFile(resolve(root, 'parent-exit'), 'exit');
        await Promise.race([activePromise, running.result.then(result => { throw prematureResult('drain not observed', result); })]);
        expect(typeof expire).toBe('function'); expire();
        await writeFile(resolve(root, 'child-exit'), 'exit');
        expect(await running.result).toMatchObject({ terminationReason: 'termination-failure',
          ownedScope: { status: 'unknown', reason: 'terminated', empty: true } });
        expect(requests).toContain('timeout');
      } finally { await running.terminate(); await scope?.dispose(); }
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15000);
