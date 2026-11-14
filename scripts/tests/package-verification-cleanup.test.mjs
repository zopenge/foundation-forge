import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { discoverWorkspacePackageModel } from '../workspace-packages.mjs';
import { createTestRunContext } from '../test-run-context.mjs';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const cleanup = await import('../package-verification-cleanup.mjs').catch(error => ({ error }));
const repositoryRoot = resolve(import.meta.dirname, '../..');
const remove = async options => {
  assert.ifError(cleanup.error);
  return cleanup.removePackageVerificationDirectory(options);
};
const identity = async directory => {
  const value = await lstat(directory, { bigint: true });
  return { dev: String(value.dev), ino: String(value.ino), canonicalPath: await realpath(directory) };
};
async function fixture(t) {
  const parent = resolve(repositoryRoot, 'tmp/tests'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, 'package-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = resolve(root, 'owned'); await mkdir(directory);
  await writeFile(resolve(directory, 'marker'), 'owned');
  return { root, repositoryRoot, directory, identity: await identity(directory), mode: 'in-process-async' };
}

test('cleanup rejects an occupied reader budget before dispatch or deletion', async t => {
  const value = await fixture(t); let dispatched = false;
  await assert.rejects(remove({ ...value, mode: 'supervised-sync', testRun: {
    budget: { summary: () => ({ activeWorkers: 1, failed: false }) },
    run: async () => { dispatched = true; },
  } }), /CLEANUP_READERS_ACTIVE/u);
  assert.equal(dispatched, false);
  assert.equal(await readFile(resolve(value.directory, 'marker'), 'utf8'), 'owned');
});

for (const mode of ['in-process-async', 'supervised-sync']) {
  test(`${mode} rejects replacement by another fixture even within the same parent`, async t => {
    const value = await fixture(t), moved = resolve(value.root, 'original');
    await rename(value.directory, moved); await mkdir(value.directory);
    await writeFile(resolve(value.directory, 'marker'), 'replacement');
    await assert.rejects(remove({ ...value, mode }), /CLEANUP_IDENTITY/u);
    assert.equal(await readFile(resolve(value.directory, 'marker'), 'utf8'), 'replacement');
    assert.equal(await readFile(resolve(moved, 'marker'), 'utf8'), 'owned');
  });
}

test('cleanup rejects a junction root and a replaced tmp ancestor without touching their targets', async t => {
  const value = await fixture(t), moved = resolve(value.root, 'original');
  await rename(value.directory, moved); await symlink(moved, value.directory, 'junction');
  await assert.rejects(remove(value), /CLEANUP_ANCESTOR/u);
  assert.equal(await readFile(resolve(moved, 'marker'), 'utf8'), 'owned');
  const fakeRepository = resolve(value.root, 'repository'); await mkdir(fakeRepository);
  await symlink(value.root, resolve(fakeRepository, 'tmp'), 'junction');
  await assert.rejects(remove({ ...value, repositoryRoot: fakeRepository,
    directory: resolve(fakeRepository, 'tmp/original'), identity: await identity(moved) }), /CLEANUP_ANCESTOR/u);
  assert.equal(await readFile(resolve(moved, 'marker'), 'utf8'), 'owned');
});

test('supervised cleanup preserves worker failure and pre-cancellation without retrying in process', async t => {
  const value = await fixture(t), failure = new Error('worker failed'); let calls = 0;
  const testRun = { budget: { summary: () => ({ activeWorkers: 0, failed: false }) },
    run: async () => { calls++; throw failure; } };
  await assert.rejects(remove({ ...value, mode: 'supervised-sync', testRun }), error => error === failure);
  assert.equal(calls, 1);
  const cancellation = new globalThis.AbortController(); cancellation.abort(failure);
  await assert.rejects(remove({ ...value, mode: 'supervised-sync', testRun, signal: cancellation.signal }), error => error === failure);
  assert.equal(calls, 1);
  assert.equal(await readFile(resolve(value.directory, 'marker'), 'utf8'), 'owned');
});

for (const mode of ['original-rm', 'supervised-sync']) test(`${mode} removes readonly files and junctions but preserves external sentinels`, async t => {
  const value = await fixture(t), outside = resolve(value.root, 'external'); await mkdir(outside);
  await writeFile(resolve(outside, 'sentinel'), 'external');
  const readonly = resolve(value.directory, 'readonly'); await writeFile(readonly, 'readonly'); await chmod(readonly, 0o444);
  await mkdir(resolve(value.directory, 'internal')); await writeFile(resolve(value.directory, 'internal/sentinel'), 'internal');
  await symlink(outside, resolve(value.directory, 'external-link'), 'junction');
  await symlink(resolve(value.directory, 'internal'), resolve(value.directory, 'internal-link'), 'junction');
  const model = await discoverWorkspacePackageModel({ repositoryRoot });
  const context = await createTestRunContext({ packages: model.packages, workers: 1 });
  try {
    if (mode === 'original-rm') await rm(value.directory, { recursive: true, force: true });
    else await remove({ ...value, mode, testRun: context });
    await assert.rejects(lstat(value.directory), { code: 'ENOENT' });
    assert.equal(await readFile(resolve(outside, 'sentinel'), 'utf8'), 'external');
  } finally {
    const summary = await context.finalize();
    assert.equal(summary.activeWorkers, 0); assert.deepEqual(summary.remainingWorkers, []);
  }
});

test('verification cleanup waits for its barrier and deletes before finalizing its own context', async () => {
  assert.equal(typeof cleanup.finishPackageVerification, 'function');
  const calls = [], failures = [];
  let release, entered;
  const barrier = new Promise(accept => { release = accept; }), ready = new Promise(accept => { entered = accept; });
  const testRun = { budget: { summary: () => ({ activeWorkers: 0, failed: false }) },
    finalize: async () => { calls.push('finalize'); } };
  const work = cleanup.finishPackageVerification({ failures, own: true, testRun,
    onBeforeCleanup: async () => { calls.push('barrier'); entered(); await barrier; },
    remove: async mode => { calls.push(mode); } });
  try { await ready; assert.deepEqual(calls, ['barrier']); }
  finally { release(); await work; }
  assert.deepEqual(calls, ['barrier', 'supervised-sync', 'finalize']);
  assert.deepEqual(failures, []);
});

test('verification failure uses explicit asynchronous cleanup and preserves every subsequent failure in order', async () => {
  assert.equal(typeof cleanup.finishPackageVerification, 'function');
  for (const primary of [new Error('body'), undefined, null, 0]) {
    const barrierFailure = new Error('barrier'), removeFailure = new Error('remove'), finalFailure = new Error('finalize');
    const failures = [primary], calls = [];
    await cleanup.finishPackageVerification({ failures, own: true,
      testRun: { cancel: async error => { assert.equal(error, primary); calls.push('cancel'); },
        budget: { summary: () => ({ activeWorkers: 0, failed: true }) },
        finalize: async () => { calls.push('finalize'); throw finalFailure; } },
      onBeforeCleanup: async (error, hasFailure) => { assert.equal(error, primary); assert.equal(hasFailure, true); throw barrierFailure; },
      remove: async mode => { calls.push(mode); throw removeFailure; } });
    assert.deepEqual(calls, ['cancel', 'in-process-async', 'finalize']);
    assert.deepEqual(failures, [primary, barrierFailure, removeFailure, finalFailure]);
  }
});

test('verification does not dispatch synchronous cleanup after cancellation or a failed barrier', async () => {
  assert.equal(typeof cleanup.finishPackageVerification, 'function');
  for (const abort of [false, true]) {
    const failure = new Error('stop'), failures = [], cancellation = new globalThis.AbortController();
    let mode;
    await cleanup.finishPackageVerification({ failures, signal: cancellation.signal,
      testRun: { budget: { summary: () => ({ activeWorkers: 0, failed: abort }) } },
      onBeforeCleanup: async () => { if (abort) cancellation.abort(failure); else throw failure; },
      remove: async selected => { mode = selected; } });
    assert.equal(mode, 'in-process-async'); assert.deepEqual(failures, [failure]);
  }
});

test('cleanup worker rechecks identity after parent validation and never deletes a replacement', async t => {
  const value = await fixture(t), moved = resolve(value.root, 'original');
  const model = await discoverWorkspacePackageModel({ repositoryRoot });
  const context = await createTestRunContext({ packages: model.packages, workers: 1 });
  let failure;
  try {
    await assert.rejects(remove({ ...value, mode: 'supervised-sync', testRun: {
      budget: context.budget, signal: context.signal,
      run: async spec => {
        await rename(value.directory, moved); await mkdir(value.directory);
        await writeFile(resolve(value.directory, 'marker'), 'replacement');
        try { return await context.run(spec); } catch (error) { failure = error; throw error; }
      },
    } }), error => error === failure && error.result.exitCode !== 0 && /CLEANUP_IDENTITY/u.test(error.message));
    assert.equal(failure.result.closure.empty, true);
    assert.equal(await readFile(resolve(value.directory, 'marker'), 'utf8'), 'replacement');
    assert.equal(await readFile(resolve(moved, 'marker'), 'utf8'), 'owned');
  } finally {
    const summary = await context.finalize(); assert.equal(summary.activeWorkers, 0); assert.deepEqual(summary.remainingWorkers, []);
  }
});

for (const reason of ['cancel', 'timeout']) test(`cleanup ${reason} waits for the real paused worker scope to empty and retains its original cause`, async t => {
  const value = await fixture(t), ready = resolve(value.root, 'ready'), pause = resolve(value.root, 'pause.mjs');
  await writeFile(pause, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(ready)},'ready');await new Promise(()=>{setInterval(()=>{},1000);});`);
  const model = await discoverWorkspacePackageModel({ repositoryRoot });
  const context = await createTestRunContext({ packages: model.packages, workers: 1 });
  const cancellation = new globalThis.AbortController(), cause = new Error(`cleanup ${reason}`);
  let failure, requestedSignal;
  const work = remove({ ...value, mode: 'supervised-sync', signal: cancellation.signal, testRun: {
    budget: context.budget, signal: context.signal,
    run: async spec => {
      requestedSignal = spec.signal;
      try { return await context.run({ ...spec, args: [...spec.args.slice(0, 2), '--import', pathToFileURL(pause).href, ...spec.args.slice(2)] }); }
      catch (error) { failure = error; throw error; }
    },
  } });
  const outcome = Promise.allSettled([work]);
  try {
    const deadline = Date.now() + 10_000;
    while (!await lstat(ready).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
      if (failure) throw failure;
      assert.ok(Date.now() < deadline, 'paused cleanup worker did not start'); await setTimeout(10);
    }
    if (reason === 'timeout') {
      const timeout = globalThis.AbortSignal.timeout(1);
      timeout.addEventListener('abort', () => cancellation.abort(timeout.reason), { once: true });
    } else cancellation.abort(cause);
    await assert.rejects(work, error => error === failure && error.cause === cancellation.signal.reason && error.result.closure.empty === true);
    assert.equal(requestedSignal, cancellation.signal);
    if (reason === 'cancel') assert.equal(cancellation.signal.reason, cause);
    else assert.equal(cancellation.signal.reason.name, 'TimeoutError');
    assert.equal(await readFile(resolve(value.directory, 'marker'), 'utf8'), 'owned');
    await assert.rejects(lstat(failure.result.temporary.path), { code: 'ENOENT' });
  } finally {
    if (!cancellation.signal.aborted) cancellation.abort(cause);
    await outcome;
    const summary = await context.finalize(); assert.equal(summary.activeWorkers, 0); assert.deepEqual(summary.remainingWorkers, []);
  }
});
