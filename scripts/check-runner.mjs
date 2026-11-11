import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { renameSync } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectDistDigests, collectTarballDigests,
  collectWorkspaceFingerprint } from './check-fingerprint.mjs';
import { createPackageManagerInvocation } from './package-manager-command.mjs';
import { discoverWorkspacePackageModel } from './workspace-packages.mjs';
import { openCheckCancellation } from './check-cancellation.mjs';
import { readFastCheckResources, resolveCheckOptions } from './check-options.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const cacheRoot = resolve(repositoryRoot, 'tmp', 'check-cache');
const tarballCacheRoot = resolve(cacheRoot, 'packs');
const statePath = resolve(cacheRoot, 'state.json');
const scriptPath = fileURLToPath(import.meta.url);

const runPnpm = (args, { signal } = {}) => new Promise((resolvePromise, reject) => {
  signal?.throwIfAborted();
  const invocation = createPackageManagerInvocation('pnpm', args);
  const child = spawn(invocation.command, invocation.args, {
    cwd: repositoryRoot, stdio: 'inherit', shell: false, windowsHide: true,
  });
  child.once('error', reject);
  child.once('close', (code) => signal?.aborted ? reject(signal.reason) : code === 0
    ? resolvePromise()
    : reject(new Error(`pnpm ${args.join(' ')} exited with ${String(code)}`)));
});

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
// 此标记只表示同步发布已完成；后续取消不能追改已提交收据的结果。
const stateCommitted = Symbol('state-committed');
export const writeState = async (fingerprint, distDigests, tarballDigests, signal,
  io = { mkdir, open, renameSync, rm }) => {
  signal?.throwIfAborted();
  await io.mkdir(cacheRoot, { recursive: true });
  signal?.throwIfAborted();
  const next = resolve(cacheRoot, `state-${process.pid}-${randomUUID()}.json`);
  let owned = false;
  try {
    const file = await io.open(next, 'wx');
    owned = true;
    const failures = [];
    try {
      signal?.throwIfAborted();
      await file.writeFile(`${JSON.stringify({ ...fingerprint, distDigests, tarballDigests }, null, 2)}\n`);
    } catch (error) { failures.push(error); }
    try { await file.close(); } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'state staging and close failed', { cause: failures[0] });
    // 所有异步工作完成后才发布；只清理自有暂存，不回滚其他运行的共享收据。
    signal?.throwIfAborted();
    io.renameSync(next, statePath);
    owned = false;
    return stateCommitted;
  } catch (error) {
    const failures = [error];
    if (owned) try { await io.rm(next, { force: true }); }
    catch (cleanupError) { failures.push(cleanupError); }
    if (failures.length > 1) throw new AggregateError(failures, 'state staging and cleanup failed', { cause: error });
    throw error;
  }
};
export const writeFullState = (fingerprint, distDigests, tarballDigests, signal, io) => writeState({ ...fingerprint,
  validation: { schemaVersion: 1, kind: 'full' } }, distDigests, tarballDigests, signal, io);
const checkUnchanged = async (before) => {
  const after = await collectWorkspaceFingerprint(repositoryRoot);
  if (!same(before, after)) throw new Error('check inputs changed during validation');
};
const runFull = async (fingerprint, model, signal) => {
  signal?.throwIfAborted();
  process.stdout.write('Full check: validating every package and real tarball.\n');
  await runPnpm(['run', 'check:full:run'], { signal });
  signal?.throwIfAborted();
  await checkUnchanged(fingerprint);
  signal?.throwIfAborted();
  return writeFullState(fingerprint, await collectDistDigests(model.packages),
    await collectTarballDigests(model.packages, tarballCacheRoot), signal);
};

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  let cancellation;
  try {
    const options = await resolveCheckOptions(process.argv.slice(2), {
      env: process.env, resources: () => readFastCheckResources(repositoryRoot),
    });
    cancellation = openCheckCancellation();
    process.stdout.write(`check cancellation file: ${cancellation.path}\n`);
    const result = options.quick
      ? await (await import('./check-quick.mjs')).runQuickCheck({ signal: cancellation.signal })
      : await runFull(await collectWorkspaceFingerprint(repositoryRoot),
        await discoverWorkspacePackageModel({ repositoryRoot }), cancellation.signal);
    if (result !== stateCommitted) cancellation.assertRunning();
  }
  catch (error) { process.stderr.write(`${error?.stack ?? error}\n`); process.exitCode = 1; }
  finally { cancellation?.close(); }
}
