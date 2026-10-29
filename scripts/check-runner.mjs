import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { renameSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectDistDigests, collectTarballDigests,
  collectWorkspaceFingerprint } from './check-fingerprint.mjs';
import { selectCheckMode } from './check-mode.mjs';
import { verifyTargetedPackages } from './check-targeted-package.mjs';
import { preparePackagesForPacking, verifyDocumentationLinks } from './package-consumer-runner.mjs';
import { createPackageManagerInvocation } from './package-manager-command.mjs';
import { discoverWorkspacePackageModel } from './workspace-packages.mjs';
import { createTestRunContext } from './test-run-context.mjs';
import { runWorkspaceCoverage } from './run-workspace-coverage.mjs';
import { runScriptTestSuite } from './run-script-tests.mjs';
import { openCheckCancellation } from './check-cancellation.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const cacheRoot = resolve(repositoryRoot, '.tmp', 'check-cache');
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

const readState = async () => {
  try { return JSON.parse(await readFile(statePath, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
};
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
const persistState = async (persist, values, signal) => {
  const result = await persist(...values, signal);
  if (result !== stateCommitted) signal?.throwIfAborted();
  return result;
};
export const writeFullState = (fingerprint, distDigests, tarballDigests, signal, io) => writeState({ ...fingerprint,
  validation: { schemaVersion: 1, kind: 'full' } }, distDigests, tarballDigests, signal, io);
const checkUnchanged = async (before) => {
  const after = await collectWorkspaceFingerprint(repositoryRoot);
  if (!same(before, after)) throw new Error('check inputs changed during validation');
};
export const verifyDist = async (model, state, mode) => {
  const expected = state?.distDigests;
  const names = model.packages.map(({ name }) => name);
  if (!expected || Object.keys(expected).length !== names.length
    || names.some((name) => !(name in expected))) return false;
  const affected = mode.kind === 'leaf' ? new Set([mode.packageName])
    : mode.kind === 'packages' ? new Set(mode.packageNames) : new Set();
  const relevant = model.packages.filter(({ name }) => !affected.has(name));
  try {
    const current = await collectDistDigests(relevant);
    return relevant.every(({ name }) => current[name] === expected[name]);
  }
  catch { return false; }
};
const verifyTarballs = async (model, state) => {
  try {
    const current = await collectTarballDigests(model.packages, tarballCacheRoot);
    return same(current, state.tarballDigests) ? current : null;
  } catch { return null; }
};

export const runScriptTests = async ({
  fingerprint,
  model,
  signal,
  state,
  run = runPnpm,
  assertInputs = checkUnchanged,
  docsValid = verifyDocumentationLinks,
  distValid = verifyDist,
  tarballsValid = verifyTarballs,
  persist = writeState,
}) => {
  signal?.throwIfAborted();
  process.stdout.write('Script test check: reusing verified package outputs.\n');
  await run(['run', 'lint'], { signal });
  signal?.throwIfAborted();
  await run(['run', 'test:scripts'], { signal });
  signal?.throwIfAborted();
  await docsValid(repositoryRoot);
  if (!await distValid(model, state, { kind: 'cached' })
    || await tarballsValid(model, state) === null) {
    throw new Error('verified package outputs changed during script test check');
  }
  signal?.throwIfAborted();
  await assertInputs(fingerprint);
  signal?.throwIfAborted();
  return persistState(persist, [fingerprint, state.distDigests, state.tarballDigests], signal);
};

const runFull = async (fingerprint, model, signal) => {
  signal?.throwIfAborted();
  process.stdout.write('Full check: validating every package and real tarball.\n');
  await runPnpm(['run', 'check:full:run'], { signal });
  signal?.throwIfAborted();
  await checkUnchanged(fingerprint);
  signal?.throwIfAborted();
  return persistState(writeFullState, [fingerprint, await collectDistDigests(model.packages),
    await collectTarballDigests(model.packages, tarballCacheRoot)], signal);
};

const runDocs = async (fingerprint, model, state, signal) => {
  signal?.throwIfAborted();
  process.stdout.write('Documentation check: reusing verified package outputs.\n');
  await runPnpm(['run', 'lint'], { signal });
  signal?.throwIfAborted();
  await verifyDocumentationLinks(repositoryRoot);
  if (!await verifyDist(model, state, { kind: 'cached' })
    || await verifyTarballs(model, state) === null) {
    throw new Error('verified package outputs changed during documentation check');
  }
  await checkUnchanged(fingerprint);
  signal?.throwIfAborted();
  return persistState(writeState, [fingerprint, state.distDigests, state.tarballDigests], signal);
};

export const runPackages = async ({
  fingerprint,
  model,
  packageNames,
  signal,
  state,
  tarballDigests,
  run = runPnpm,
  targetedVerify = verifyTargetedPackages,
  assertInputs = checkUnchanged,
  docsValid = verifyDocumentationLinks,
  distValid = verifyDist,
  tarballsValid = verifyTarballs,
  persist = writeState,
  createContext = createTestRunContext,
  coverage = runWorkspaceCoverage,
  scriptTests = runScriptTestSuite,
  prepare = preparePackagesForPacking,
  removeWorkRoot = directory => rm(directory, { recursive: true, force: true }),
}) => {
  signal?.throwIfAborted();
  const names = new Set(packageNames);
  const packages = model.packages.filter(({ name }) => names.has(name));
  if (packages.length !== names.size || packages.length === 0)
    throw new Error('unknown targeted package group');
  await mkdir(cacheRoot, { recursive: true });
  const workRoot = await mkdtemp(resolve(cacheRoot, 'verify-'));
  const inside = relative(cacheRoot, workRoot);
  if (inside === '' || inside.startsWith('..') || resolve(cacheRoot, inside) !== workRoot)
    throw new Error('unsafe check cache cleanup path');
  let testRun, committed, cleanupAttempted = false;
  const failures = [];
  try {
    process.stdout.write(`Targeted package group: ${packageNames.join(', ')}.\n`);
    signal?.throwIfAborted();
    await run(['run', 'lint'], { signal });
    signal?.throwIfAborted();
    await prepare({
      model: { ...model, packages },
      build: async () => {
        for (const { name } of packages) { signal?.throwIfAborted(); await run(['--filter', name, 'run', 'build'], { signal }); }
      },
    });
    signal?.throwIfAborted();
    testRun = await createContext({ packages: model.packages, signal });
    signal?.throwIfAborted();
    const reusedTarballs = new Map(Object.entries(tarballDigests)
      .filter(([name]) => !names.has(name))
      .map(([name, value]) => [name, resolve(tarballCacheRoot, value.filename)]));
    const verified = await targetedVerify({ model, packageNames, verificationRoot: workRoot, reusedTarballs, testRun });
    for (const { name } of packages) { signal?.throwIfAborted(); await run(['--filter', name, 'run', 'typecheck'], { signal }); }
    signal?.throwIfAborted();
    await scriptTests(testRun);
    signal?.throwIfAborted();
    await coverage({ packages, context: testRun });
    signal?.throwIfAborted();
    await docsValid(repositoryRoot);
    if (!await distValid(model, state, { kind: 'packages', packageNames })
      || await tarballsValid(model, state) === null) {
      throw new Error('verified unaffected package outputs changed during targeted check');
    }
    const targetTarballs = verified.targetTarballs;
    for (const name of packageNames) {
      const source = targetTarballs.get(name);
      if (!source || !tarballDigests[name]) throw new Error(`missing targeted tarball: ${name}`);
      await copyFile(source, resolve(tarballCacheRoot, tarballDigests[name].filename));
    }
    const distDigests = { ...state.distDigests, ...await collectDistDigests(packages) };
    const currentTarballs = await collectTarballDigests(model.packages, tarballCacheRoot);
    const nextTarballs = { ...state.tarballDigests };
    for (const name of packageNames) nextTarballs[name] = currentTarballs[name];
    const completedRun = testRun;
    testRun = undefined;
    await completedRun.finalize();
    cleanupAttempted = true;
    await removeWorkRoot(workRoot);
    signal?.throwIfAborted();
    await assertInputs(fingerprint);
    signal?.throwIfAborted();
    committed = await persistState(persist, [fingerprint, distDigests, nextTarballs], signal);
  } catch (error) {
    failures.push(error);
    try { testRun?.budget.stop(error); await testRun?.cancel?.(error); }
    catch (stopError) { failures.push(stopError); }
  } finally {
    if (testRun) try { await testRun.finalize(); } catch (error) { failures.push(error); }
    if (!cleanupAttempted) try { await removeWorkRoot(workRoot); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'targeted check failed and cleanup failed', { cause: failures[0] });
  return committed;
};

export const runCheck = async ({ signal, full = false } = {}) => {
  signal?.throwIfAborted();
  await mkdir(cacheRoot, { recursive: true });
  const model = await discoverWorkspacePackageModel({ repositoryRoot });
  const fingerprint = await collectWorkspaceFingerprint(repositoryRoot);
  if (full) return runFull(fingerprint, model, signal);
  const state = await readState();
  const mode = selectCheckMode(state, fingerprint, model.packages);
  const validCache = mode.kind === 'full' || !await verifyDist(model, state, mode)
    ? null : await verifyTarballs(model, state);
  signal?.throwIfAborted();
  if (mode.kind === 'cached' && validCache !== null) {
    await checkUnchanged(fingerprint);
    signal?.throwIfAborted();
    process.stdout.write('Check passed: exact source, environment, and built outputs match validated receipt.\n');
    return;
  }
  if (mode.kind === 'docs' && validCache !== null) {
    return runDocs(fingerprint, model, state, signal);
  }
  if (mode.kind === 'script-tests' && validCache !== null) {
    return runScriptTests({ fingerprint, model, state, signal });
  }
  if (mode.kind === 'leaf' && validCache !== null) {
    return runPackages({ fingerprint, model, signal, packageNames: [mode.packageName],
      state, tarballDigests: validCache });
  }
  if (mode.kind === 'packages' && validCache !== null) {
    return runPackages({ fingerprint, model, signal, packageNames: mode.packageNames,
      state, tarballDigests: validCache });
  }
  return runFull(fingerprint, model, signal);
};

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  let cancellation;
  try {
    const args = process.argv.slice(2);
    if (new Set(args).size !== args.length || args.some(arg => !['--quick', '--full', '--serial'].includes(arg))
      || args.includes('--quick') && args.includes('--full') || args.includes('--serial') && !args.includes('--full')) throw new Error('CHECK_ARGUMENT_INVALID');
    if (args.includes('--serial')) process.env.FORGE_CHECK_TEST_WORKERS = '1';
    cancellation = openCheckCancellation();
    process.stdout.write(`check cancellation file: ${cancellation.path}\n`);
    const result = args.includes('--quick')
      ? await (await import('./check-quick.mjs')).runQuickCheck({ signal: cancellation.signal })
      : await runCheck({ signal: cancellation.signal, full: args.includes('--full') });
    if (result !== stateCommitted) cancellation.assertRunning();
  }
  catch (error) { process.stderr.write(`${error?.stack ?? error}\n`); process.exitCode = 1; }
  finally { cancellation?.close(); }
}
