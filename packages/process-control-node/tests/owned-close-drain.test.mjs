import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { TextDecoder } from 'node:util';
import { expect, test } from 'vitest';
import { createWindowsOwnedProcessScopeProvider, createWindowsProcessIdentityReader } from '../dist/index.js';
import { observeLiveJobMember } from './helpers/live-job-member.mjs';

const deferred = () => { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; };
const supported = process.platform === 'win32' && process.arch === 'x64';

for (const action of ['natural', 'cancel', 'deadline']) test.runIf(supported)(
  `keeps real Job closure bounded and irreversible during ${action} drain`, async () => {
    const base = resolve(import.meta.dirname, '../../../.tmp/owned-scope-tests');
    await mkdir(base, { recursive: true });
    const root = await mkdtemp(resolve(base, 'drain-'));
    const ready = deferred(), live = deferred();
    let childPid, scope, output = '';
    try {
      await observeLiveJobMember(() => childPid, () => live.resolve(), async () => {
        scope = createWindowsOwnedProcessScopeProvider().start({ command: process.execPath,
          args: [resolve(import.meta.dirname, 'fixtures/owned-drain.mjs'), 'parent', root],
          environment: process.env, binding: `drain-${action}`, startupTimeoutMs: 10000,
          terminationTimeoutMs: action === 'deadline' ? 1000 : 5000 }, event => {
          if (event.stream !== 'stdout') return;
          output += new TextDecoder().decode(event.chunk);
          if (output.includes('\n')) { childPid = JSON.parse(output.trim()).pid; ready.resolve(); }
        });
        try {
          const identity = await createWindowsProcessIdentityReader().readIdentity({ pid: await scope.rootPid });
          if (identity.status !== 'FOUND') throw new Error('fixture root missing');
          await scope.bind(identity.identity); await scope.authorize();
          await Promise.race([ready.promise, scope.completion.then(() => { throw new Error('fixture exited before ready'); })]);
          await writeFile(resolve(root, 'parent-exit'), 'exit');
          await Promise.race([live.promise, scope.completion.then(() => { throw new Error('no live member observed'); })]);
          if (action === 'natural') {
            await writeFile(resolve(root, 'child-exit'), 'exit');
            expect(await scope.completion).toMatchObject({ exitCode: 0,
              closure: { status: 'closed', reason: 'normal', empty: true } });
          } else if (action === 'cancel') {
            const terminated = scope.terminate({ mode: 'force' });
            await writeFile(resolve(root, 'child-exit'), 'exit');
            expect(await terminated).toMatchObject({ status: 'unknown', reason: 'terminated', empty: true });
          } else {
            expect(await scope.completion).toMatchObject({
              closure: { status: 'unknown', reason: 'descendants-remained', empty: true } });
          }
        } finally { await scope.dispose(); }
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 15000);
