import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createWindowsOwnedProcessScopeProvider, createWindowsProcessIdentityReader } from '../../dist/index.js';
import { observeWindowsJobMembers } from '../helpers/windows-job-observer.mjs';
import { fixtureConsole } from '../helpers/windows-fixture-console.mjs';

export const assertNestedGitResult = row => {
  const context = JSON.stringify(row);
  assert.equal(row.result.exitCode, 0, context);
  assert.equal(row.result.closure.status, 'closed', context);
  assert.equal(row.result.closure.reason, 'normal', context);
  assert.equal(row.result.closure.empty, true, context);
  assert.match(row.stdout, /^[a-f0-9]{40,64}$/u);
};

export async function runNestedGit({ windowsHide, iterations = 12, root, inspect = assertNestedGitResult }) {
  if (typeof windowsHide !== 'boolean' || ![1, 12].includes(iterations)) throw new Error('FIXTURE_GIT_ARGUMENTS');
  const observation = await observeWindowsJobMembers(), rows = [];
  try {
    for (let attempt = 0; attempt < iterations; attempt++) {
      observation.members.length = 0;
      const output = [], proof = root && resolve(root, `child-${attempt}.json`);
      const args = proof ? [fileURLToPath(import.meta.url), 'git-child', proof, String(windowsHide), String(process.pid)]
        : ['-e', 'process.stdout.write(require("node:child_process").execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8",windowsHide:process.argv[1] === "true"}).trim())', String(windowsHide)];
      const scope = createWindowsOwnedProcessScopeProvider().start({ command: process.execPath, args,
        environment: process.env, binding: 'nested-git', startupTimeoutMs: 10_000, terminationTimeoutMs: 5000 }, event => {
        if (event.stream === 'stdout') output.push(Buffer.from(event.chunk));
      });
      try {
        const value = await createWindowsProcessIdentityReader().readIdentity({ pid: await scope.rootPid });
        if (value.status !== 'FOUND') throw Error('fixture root absent');
        await scope.bind(value.identity); await scope.authorize();
        const result = await scope.completion;
        const row = { attempt, windowsHide, result, stdout: Buffer.concat(output).toString('utf8'), members: [...observation.members],
          ...(proof ? { child: JSON.parse(await readFile(proof, 'utf8')) } : {}) };
        inspect(row); rows.push(row);
      } finally { await scope.dispose(); }
    }
  } finally { observation.restore(); }
  return rows;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'git-child') {
    const console = await fixtureConsole({ ownerPid: Number(process.argv[5]) });
    await writeFile(process.argv[3], JSON.stringify({ console, windowsHide: process.argv[4] === 'true' }), { flag: 'wx' });
    process.stdout.write(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: process.argv[4] === 'true' }).trim());
  } else if (process.argv[2] === 'host') {
    const request = JSON.parse(await readFile(process.argv[3], 'utf8'));
    process.once('uncaughtExceptionMonitor', error => writeFileSync(resolve(request.root, 'failure.json'), JSON.stringify({ message: error.message, stack: error.stack,
      errors: error.errors?.map(value => ({ message: value.message, stack: value.stack })) })));
    const console = await fixtureConsole();
    const rows = await runNestedGit({ windowsHide: false, iterations: request.iterations, root: request.root });
    await writeFile(request.result, JSON.stringify({ pid: process.pid, console, rows }), { flag: 'wx' });
  } else throw new Error('FIXTURE_GIT_MODE');
}
