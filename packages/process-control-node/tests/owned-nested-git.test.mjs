import { Buffer } from 'node:buffer';
import { basename } from 'node:path';
import process from 'node:process';
import { expect, test } from 'vitest';
import { createWindowsOwnedProcessScopeProvider, createWindowsProcessIdentityReader } from '../dist/index.js';
import { observeWindowsJobMembers } from './helpers/windows-job-observer.js';

test.runIf(process.platform === 'win32' && process.arch === 'x64').each([true, false])('closes a Node command after synchronous nested Git (windowsHide=%s)', async windowsHide => {
  const observation = await observeWindowsJobMembers();
  try {
    for (let attempt = 0; attempt < 12; attempt++) {
      observation.members.length = 0;
      const output = [];
      const scope = createWindowsOwnedProcessScopeProvider().start({ command: process.execPath,
        args: ['-e', 'process.stdout.write(require("node:child_process").execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8",windowsHide:process.argv[1] === "true"}).trim())', String(windowsHide)],
        environment: process.env, binding: 'nested-git', startupTimeoutMs: 10_000, terminationTimeoutMs: 5000 }, event => {
        if (event.stream === 'stdout') output.push(Buffer.from(event.chunk));
      });
      try {
        const value = await createWindowsProcessIdentityReader().readIdentity({ pid: await scope.rootPid });
        if (value.status !== 'FOUND') throw Error('fixture root absent');
        await scope.bind(value.identity); await scope.authorize();
        const result = await scope.completion;
        expect(result, JSON.stringify({ attempt, windowsHide, members: observation.members })).toMatchObject({
          exitCode: 0, closure: { status: 'closed', reason: 'normal', empty: true },
        });
        expect(Buffer.concat(output).toString('utf8')).toMatch(/^[a-f0-9]{40,64}$/u);
      } finally { await scope.dispose(); }
    }
  } finally { observation.restore(); }
}, 180_000);

test.runIf(process.platform === 'win32' && process.arch === 'x64')('records the actual live member without hiding a failed foreground closure', async () => {
  const observation = await observeWindowsJobMembers();
  let scope;
  try {
    scope = createWindowsOwnedProcessScopeProvider().start({ command: process.execPath,
      args: ['-e', 'const child=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"});child.unref()'],
      environment: process.env, binding: 'observed-descendant', startupTimeoutMs: 10_000, terminationTimeoutMs: 5000 });
    const value = await createWindowsProcessIdentityReader().readIdentity({ pid: await scope.rootPid });
    if (value.status !== 'FOUND') throw Error('fixture root absent');
    await scope.bind(value.identity); await scope.authorize();
    expect((await scope.completion).closure).toMatchObject({ status: 'unknown', reason: 'descendants-remained', empty: true });
    expect(observation.members).toContainEqual(expect.objectContaining({ belongs: 1, wait: 258, exitCode: 259, image: basename(process.execPath) }));
  } finally { try { await scope?.dispose(); } finally { observation.restore(); } }
}, 30_000);
