import { basename } from 'node:path';
import process from 'node:process';
import { expect, test } from 'vitest';
import { createWindowsOwnedProcessScopeProvider, createWindowsProcessIdentityReader } from '../dist/index.js';
import { observeWindowsJobMembers } from './helpers/windows-job-observer.mjs';
import { runNestedGit } from './fixtures/nested-git.mjs';
import { runIsolatedNestedGit } from './helpers/isolated-nested-git.mjs';

test.runIf(process.platform === 'win32' && process.arch === 'x64').each([true, false])('closes a Node command after synchronous nested Git (windowsHide=%s)', async windowsHide => {
  const inspect = row => {
    expect(row.result, JSON.stringify({ attempt: row.attempt, windowsHide, members: row.members })).toMatchObject({
      exitCode: 0, closure: { status: 'closed', reason: 'normal', empty: true },
    });
    expect(row.stdout).toMatch(/^[a-f0-9]{40,64}$/u);
  };
  const rows = windowsHide ? await runNestedGit({ windowsHide, inspect }) : (await runIsolatedNestedGit()).rows;
  expect(rows).toHaveLength(12);
  for (const row of rows) inspect(row);
}, 180_000);

test.runIf(process.platform === 'win32' && process.arch === 'x64')('records the actual live member without hiding a failed foreground closure', async () => {
  const observation = await observeWindowsJobMembers();
  let scope;
  try {
    scope = createWindowsOwnedProcessScopeProvider().start({ command: process.execPath,
      args: ['-e', 'const child=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore",windowsHide:true});child.unref()'],
      environment: process.env, binding: 'observed-descendant', startupTimeoutMs: 10_000, terminationTimeoutMs: 5000 });
    const value = await createWindowsProcessIdentityReader().readIdentity({ pid: await scope.rootPid });
    if (value.status !== 'FOUND') throw Error('fixture root absent');
    await scope.bind(value.identity); await scope.authorize();
    expect((await scope.completion).closure).toMatchObject({ status: 'unknown', reason: 'descendants-remained', empty: true });
    expect(observation.members).toContainEqual(expect.objectContaining({ belongs: 1, wait: 258, exitCode: 259, image: basename(process.execPath) }));
  } finally { try { await scope?.dispose(); } finally { observation.restore(); } }
}, 30_000);
