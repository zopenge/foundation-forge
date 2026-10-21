import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectDistDigests, collectTarballDigests,
  collectWorkspaceFingerprint } from './check-fingerprint.mjs';
import { selectCheckMode } from './check-mode.mjs';
import { verifyTargetedPackages } from './check-targeted-package.mjs';
import { preparePackagesForPacking, verifyDocumentationLinks } from './package-consumer-runner.mjs';
import { createPackageManagerInvocation } from './package-manager-command.mjs';
import { discoverWorkspacePackageModel } from './workspace-packages.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const cacheRoot = resolve(repositoryRoot, '.tmp', 'check-cache');
const tarballCacheRoot = resolve(cacheRoot, 'packs');
const statePath = resolve(cacheRoot, 'state.json');
const scriptPath = fileURLToPath(import.meta.url);

const runPnpm = (args) => new Promise((resolvePromise, reject) => {
  const invocation = createPackageManagerInvocation('pnpm', args);
  const child = spawn(invocation.command, invocation.args, {
    cwd: repositoryRoot, stdio: 'inherit', shell: false, windowsHide: true,
  });
  child.once('error', reject);
  child.once('exit', (code) => code === 0
    ? resolvePromise()
    : reject(new Error(`pnpm ${args.join(' ')} exited with ${String(code)}`)));
});

const readState = async () => {
  try { return JSON.parse(await readFile(statePath, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
};
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const writeState = async (fingerprint, distDigests, tarballDigests) => {
  await mkdir(cacheRoot, { recursive: true });
  const next = resolve(cacheRoot, `state-${process.pid}.json`);
  await writeFile(next, `${JSON.stringify({ ...fingerprint, distDigests, tarballDigests }, null, 2)}\n`,
    { flag: 'wx' });
  await rename(next, statePath);
};
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
  state,
  run = runPnpm,
  assertInputs = checkUnchanged,
  docsValid = verifyDocumentationLinks,
  distValid = verifyDist,
  tarballsValid = verifyTarballs,
  persist = writeState,
}) => {
  process.stdout.write('Script test check: reusing verified package outputs.\n');
  const results = await Promise.allSettled([
    run(['run', 'lint']),
    run(['run', 'test:scripts']),
  ]);
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
  await docsValid(repositoryRoot);
  if (!await distValid(model, state, { kind: 'cached' })
    || await tarballsValid(model, state) === null) {
    throw new Error('verified package outputs changed during script test check');
  }
  await assertInputs(fingerprint);
  await persist(fingerprint, state.distDigests, state.tarballDigests);
};

const runFull = async (fingerprint, model) => {
  process.stdout.write('Full check: validating every package and real tarball.\n');
  await runPnpm(['run', 'check:full']);
  await checkUnchanged(fingerprint);
  await writeState(fingerprint, await collectDistDigests(model.packages),
    await collectTarballDigests(model.packages, tarballCacheRoot));
};

const runDocs = async (fingerprint, model, state) => {
  process.stdout.write('Documentation check: reusing verified package outputs.\n');
  await runPnpm(['run', 'lint']);
  await verifyDocumentationLinks(repositoryRoot);
  if (!await verifyDist(model, state, { kind: 'cached' })
    || await verifyTarballs(model, state) === null) {
    throw new Error('verified package outputs changed during documentation check');
  }
  await checkUnchanged(fingerprint);
  await writeState(fingerprint, state.distDigests, state.tarballDigests);
};

export const runPackages = async ({
  fingerprint,
  model,
  packageNames,
  state,
  tarballDigests,
  run = runPnpm,
  targetedVerify = verifyTargetedPackages,
  assertInputs = checkUnchanged,
  docsValid = verifyDocumentationLinks,
  distValid = verifyDist,
  tarballsValid = verifyTarballs,
  persist = writeState,
}) => {
  const names = new Set(packageNames);
  const packages = model.packages.filter(({ name }) => names.has(name));
  if (packages.length !== names.size || packages.length === 0)
    throw new Error('unknown targeted package group');
  await mkdir(cacheRoot, { recursive: true });
  const workRoot = await mkdtemp(resolve(cacheRoot, 'verify-'));
  const inside = relative(cacheRoot, workRoot);
  if (inside === '' || inside.startsWith('..') || resolve(cacheRoot, inside) !== workRoot)
    throw new Error('unsafe check cache cleanup path');
  try {
    process.stdout.write(`Targeted package group: ${packageNames.join(', ')}.\n`);
    const lint = run(['run', 'lint']);
    const build = preparePackagesForPacking({
      model: { ...model, packages },
      build: async () => {
        for (const { name } of packages) await run(['--filter', name, 'run', 'build']);
      },
    });
    const first = await Promise.allSettled([lint, build]);
    const failedFirst = first.find((result) => result.status === 'rejected');
    if (failedFirst) throw failedFirst.reason;
    const reusedTarballs = new Map(Object.entries(tarballDigests)
      .filter(([name]) => !names.has(name))
      .map(([name, value]) => [name, resolve(tarballCacheRoot, value.filename)]));
    const checks = [
      run(['run', 'test:scripts']),
      targetedVerify({ model, packageNames, verificationRoot: workRoot, reusedTarballs }),
      ...packages.map(({ name }) => run(['--filter', name, 'run', 'typecheck'])),
      ...packages.map(({ name, manifest }) => run(['--filter', name, 'run',
        manifest.scripts?.['test:coverage:fast'] ? 'test:coverage:fast' : 'test:coverage'])),
    ];
    const second = await Promise.allSettled(checks);
    const failedSecond = second.find((result) => result.status === 'rejected');
    if (failedSecond) throw failedSecond.reason;
    await docsValid(repositoryRoot);
    if (!await distValid(model, state, { kind: 'packages', packageNames })
      || await tarballsValid(model, state) === null) {
      throw new Error('verified unaffected package outputs changed during targeted check');
    }
    const targetTarballs = second[1].value.targetTarballs;
    for (const name of packageNames) {
      const source = targetTarballs.get(name);
      if (!source || !tarballDigests[name]) throw new Error(`missing targeted tarball: ${name}`);
      await copyFile(source, resolve(tarballCacheRoot, tarballDigests[name].filename));
    }
    const distDigests = { ...state.distDigests, ...await collectDistDigests(packages) };
    const currentTarballs = await collectTarballDigests(model.packages, tarballCacheRoot);
    const nextTarballs = { ...state.tarballDigests };
    for (const name of packageNames) nextTarballs[name] = currentTarballs[name];
    await assertInputs(fingerprint);
    await persist(fingerprint, distDigests, nextTarballs);
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
};

export const runCheck = async () => {
  await mkdir(cacheRoot, { recursive: true });
  const model = await discoverWorkspacePackageModel({ repositoryRoot });
  const fingerprint = await collectWorkspaceFingerprint(repositoryRoot);
  const state = await readState();
  const mode = selectCheckMode(state, fingerprint, model.packages);
  const validCache = mode.kind === 'full' || !await verifyDist(model, state, mode)
    ? null : await verifyTarballs(model, state);
  if (mode.kind === 'cached' && validCache !== null) {
    await checkUnchanged(fingerprint);
    process.stdout.write('Check passed: exact source, environment, and built outputs match validated receipt.\n');
    return;
  }
  if (mode.kind === 'docs' && validCache !== null) {
    await runDocs(fingerprint, model, state);
    return;
  }
  if (mode.kind === 'script-tests' && validCache !== null) {
    await runScriptTests({ fingerprint, model, state });
    return;
  }
  if (mode.kind === 'leaf' && validCache !== null) {
    await runPackages({ fingerprint, model, packageNames: [mode.packageName],
      state, tarballDigests: validCache });
    return;
  }
  if (mode.kind === 'packages' && validCache !== null) {
    await runPackages({ fingerprint, model, packageNames: mode.packageNames,
      state, tarballDigests: validCache });
    return;
  }
  await runFull(fingerprint, model);
};

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try { await runCheck(); }
  catch (error) { process.stderr.write(`${error?.stack ?? error}\n`); process.exitCode = 1; }
}
