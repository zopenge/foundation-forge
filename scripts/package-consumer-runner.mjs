import { execFile, spawnSync } from 'node:child_process';
import {
  access,
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { basename, dirname, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

import { createPackageManagerInvocation } from './package-manager-command.mjs';
import {
  createConsumerConfiguration,
  createConsumerImportScript,
  createPnpmWorkspaceConfiguration,
  loadPackageVerification,
  verifyBrowserBoundaries,
} from './package-verification.mjs';
import { discoverWorkspacePackageModel } from './workspace-packages.mjs';

const ignoredDirectories = new Set(['.git', '.tmp', 'coverage', 'dist', 'node_modules']);
const execFileAsync = promisify(execFile);
const packageConcurrency = Math.min(8, availableParallelism());

export const runBounded = async (items, limit, task) => {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid task concurrency');
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  let failure;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { results[index] = await task(items[index], index); }
      catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed) throw failure;
  return results;
};

const run = (command, args, { cwd, env = process.env } = {}) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env,
    maxBuffer: 16 * 1_024 * 1_024,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(' ')} failed with status ${String(result.status)}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'));
  }
  return result.stdout.trim();
};

export const runCaptured = async (command, args, { cwd, env = process.env } = {}) => {
  try {
    const result = await execFileAsync(command, args, {
      cwd, env, maxBuffer: 16 * 1_024 * 1_024, windowsHide: true, shell: false,
    });
    return result.stdout.trim();
  } catch (error) {
    throw new Error([
      `${command} ${args.join(' ')} failed with status ${String(error.code ?? error.signal)}`,
      error.stdout, error.stderr,
    ].filter(Boolean).join('\n'), { cause: error });
  }
};

const runPnpm = (args, options) => {
  const invocation = createPackageManagerInvocation('pnpm', args);
  return run(invocation.command, invocation.args, options);
};
const runPnpmAsync = (args, options) => {
  const invocation = createPackageManagerInvocation('pnpm', args);
  return runCaptured(invocation.command, invocation.args, options);
};

const pathExists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const verifyRepositoryHygiene = async (repositoryRoot) => {
  for (const lockfile of ['package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb']) {
    if (await pathExists(resolve(repositoryRoot, lockfile))) {
      throw new Error(`unexpected repository file: ${lockfile}`);
    }
  }
  const npmrc = await readFile(resolve(repositoryRoot, '.npmrc'), 'utf8');
  if ([/_authToken\s*=/iu, /_auth\s*=/iu, /password\s*=/iu, /username\s*=/iu]
    .some((pattern) => pattern.test(npmrc))) {
    throw new Error('root .npmrc contains authentication material');
  }
  const workflowDirectory = resolve(repositoryRoot, '.github', 'workflows');
  for (const workflowName of await readdir(workflowDirectory)) {
    const workflow = await readFile(resolve(workflowDirectory, workflowName), 'utf8');
    if (workflow.includes('NPM' + '_TOKEN')) {
      throw new Error(`${workflowName} configures a long-lived npm token`);
    }
  }
};

const listMarkdownFiles = async (root, directory = root) => {
  const results = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        results.push(...await listMarkdownFiles(root, resolve(directory, entry.name)));
      }
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      results.push(relative(root, resolve(directory, entry.name)).replaceAll('\\', '/'));
    }
  }
  return results.sort();
};

export const verifyDocumentationLinks = async (repositoryRoot) => {
  const markdownLink = /\[[^\]]*\]\(([^)]+)\)/gu;
  for (const markdownPath of await listMarkdownFiles(repositoryRoot)) {
    const source = await readFile(resolve(repositoryRoot, markdownPath), 'utf8');
    for (const match of source.matchAll(markdownLink)) {
      const target = (match[1]?.split('#')[0] ?? '').trim();
      if (
        target === ''
        || target.startsWith('https://')
        || target.startsWith('http://')
        || target.startsWith('mailto:')
      ) continue;
      const localTarget = resolve(repositoryRoot, dirname(markdownPath), decodeURIComponent(target));
      if (!await pathExists(localTarget)) {
        throw new Error(`${markdownPath} links to missing local target: ${target}`);
      }
    }
  }
};

const repositoryUrl = (repository) => typeof repository === 'string' ? repository : repository?.url;

export const verifyManifest = async (packageValue, rootManifest) => {
  const { manifest, name } = packageValue;
  if (manifest.private === true || manifest.publishConfig?.access !== 'public') {
    throw new Error(`${name} is not configured as a public package`);
  }
  if (repositoryUrl(manifest.repository) !== repositoryUrl(rootManifest.repository)) {
    throw new Error(`${name} repository URL differs from the root manifest`);
  }
  if (manifest.repository?.directory !== packageValue.directory) {
    throw new Error(`${name} repository directory is incorrect`);
  }
  if (manifest.engines?.node !== rootManifest.engines?.node) {
    throw new Error(`${name} Node.js engine differs from the root manifest`);
  }
  if (manifest.sideEffects !== false) throw new Error(`${name} must declare sideEffects false`);
  const files = manifest.files;
  if (!Array.isArray(files) || ['dist', 'README.md', 'LICENSE', 'NOTICE'].some((value) => !files.includes(value))) {
    throw new Error(`${name} must publish dist, README.md, LICENSE, and NOTICE`);
  }
  for (const entry of packageValue.exports) {
    if (!entry.importTarget.startsWith('./') || !entry.typesTarget?.startsWith('./')) {
      throw new Error(`${name} export ${entry.subpath} must declare relative import and types targets`);
    }
  }
  for (const bin of packageValue.bins) {
    if (!bin.target.startsWith('./')) throw new Error(`${name} bin ${bin.name} must use a relative target`);
  }
  packageValue.verification = await loadPackageVerification(packageValue);
};

const tarEntries = (tarballPath, repositoryRoot) => run(
  'tar',
  ['-tzf', tarballPath],
  { cwd: repositoryRoot },
).split(/\r?\n/u).filter(Boolean);

const verifyTarball = (packageValue, tarballPath, repositoryRoot) => {
  const entries = tarEntries(tarballPath, repositoryRoot);
  const required = ['package/package.json', 'package/README.md', 'package/LICENSE', 'package/NOTICE'];
  for (const path of required) {
    if (!entries.includes(path)) throw new Error(`${packageValue.name} tarball is missing ${path}`);
  }
  const allowed = packageValue.manifest.files;
  const unexpected = entries.filter((path) => {
    if (path === 'package/package.json') return false;
    return !allowed.some((item) => path === `package/${item}` || path.startsWith(`package/${item}/`));
  });
  if (unexpected.length > 0) {
    throw new Error(`${packageValue.name} tarball contains unexpected files: ${unexpected.join(', ')}`);
  }
  for (const target of [
    ...packageValue.exports.flatMap(({ importTarget, typesTarget }) => [importTarget, typesTarget]),
    ...packageValue.bins.map(({ target }) => target),
  ].filter(Boolean)) {
    const entry = `package/${target.slice(2)}`;
    if (!entries.includes(entry)) throw new Error(`${packageValue.name} tarball is missing ${entry}`);
  }
  const packedManifest = run('tar', ['-xOf', tarballPath, 'package/package.json'], {
    cwd: repositoryRoot,
  });
  if (packedManifest.includes('workspace:')) {
    throw new Error(`${packageValue.name} tarball contains unresolved workspace dependencies`);
  }
  const packedPackage = JSON.parse(packedManifest);
  if (packedPackage.name !== packageValue.name || packedPackage.version !== packageValue.version) {
    throw new Error(`${packageValue.name} tarball identity differs from the workspace manifest`);
  }
  return entries;
};

const packageSlug = (name) => name.replace(/^@/u, '').replaceAll('/', '-');

export const packPackages = async (model, verificationRoot, { reusedTarballs } = {}) => {
  const packDirectory = resolve(verificationRoot, 'packs');
  const extractDirectory = resolve(verificationRoot, 'extracted');
  await mkdir(packDirectory, { recursive: true });
  await mkdir(extractDirectory, { recursive: true });
  const rows = await runBounded(model.packages, packageConcurrency, async (packageValue, index) => {
    let tarballPath = reusedTarballs?.get(packageValue.name);
    if (tarballPath === undefined) {
      const destination = resolve(packDirectory, String(index));
      await mkdir(destination);
      await runPnpmAsync(['--filter', packageValue.name, 'pack', '--pack-destination', destination], {
        cwd: model.repositoryRoot,
      });
      const created = await readdir(destination);
      if (created.length !== 1) {
        throw new Error(`${packageValue.name} produced ${String(created.length)} tarballs`);
      }
      tarballPath = resolve(destination, created[0]);
    }
    const entries = verifyTarball(packageValue, tarballPath, model.repositoryRoot);
    const extractedRoot = resolve(extractDirectory, String(index));
    await mkdir(extractedRoot, { recursive: true });
    run('tar', ['-xzf', tarballPath, '-C', extractedRoot], { cwd: model.repositoryRoot });
    return { packageValue, tarballPath, packedFiles: entries.length,
      extractedPackage: { ...packageValue,
        packageRoot: resolve(extractedRoot, 'package') } };
  });
  const tarballs = new Map(rows.map(({ packageValue, tarballPath }) =>
    [packageValue.name, tarballPath]));
  for (const row of rows) {
    process.stdout.write(`${row.packageValue.name}: verified ${String(row.packedFiles)} packed files\n`);
  }
  return { extractedPackages: rows.map((row) => row.extractedPackage), tarballs };
};

export const preparePackagesForPacking = async ({
  build = async () => runPnpm(['run', 'build'], { cwd: model.repositoryRoot }),
  model,
}) => {
  await Promise.all(model.packages.map(({ packageRoot }) => (
    rm(resolve(packageRoot, 'dist'), { force: true, recursive: true })
  )));
  await build();
};

const packageInstallationPath = (consumerRoot, packageName) => resolve(
  consumerRoot,
  'node_modules',
  ...packageName.split('/'),
);

export const runConsumerChecks = async ({ importCheck, smokeChecks }) => {
  const start = (task) => {
    try { return Promise.resolve(task()); }
    catch (error) { return Promise.reject(error); }
  };
  const results = await Promise.allSettled([start(importCheck), start(smokeChecks)]);
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
  return results[0].value;
};

export const runCleanPackageConsumer = async ({
  consumerRoot,
  model,
  references,
  smokePackageNames,
}) => {
  const started = performance.now();
  const { dependencies, overrides } = createConsumerConfiguration({
    packages: model.packages,
    references,
  });
  await mkdir(consumerRoot, { recursive: true });
  await writeFile(resolve(consumerRoot, 'package.json'), `${JSON.stringify({
    dependencies,
    name: 'foundation-forge-package-consumer',
    private: true,
    type: 'module',
    version: '0.0.0',
  }, null, 2)}\n`, 'utf8');
  const rootWorkspace = await readFile(resolve(model.repositoryRoot, 'pnpm-workspace.yaml'), 'utf8');
  await writeFile(
    resolve(consumerRoot, 'pnpm-workspace.yaml'),
    createPnpmWorkspaceConfiguration(rootWorkspace, overrides),
    'utf8',
  );
  const npmrc = await readFile(resolve(model.repositoryRoot, '.npmrc'), 'utf8');
  await writeFile(
    resolve(consumerRoot, '.npmrc'),
    `${npmrc.trimEnd()}\nnode-linker=hoisted\npackage-import-method=copy\n`,
    'utf8',
  );
  await writeFile(resolve(consumerRoot, 'verify.mjs'), createConsumerImportScript(model.packages), 'utf8');
  runPnpm(['install', '--prefer-offline', '--frozen-lockfile=false'], { cwd: consumerRoot });
  process.stdout.write(`pack:check consumer install: ${((performance.now() - started) / 1_000).toFixed(2)}s\n`);
  const binaries = Object.fromEntries(model.packages.flatMap((packageValue) => packageValue.bins.map(
    ({ name, target }) => [name, resolve(packageInstallationPath(consumerRoot, packageValue.name), target)],
  )));
  const smokes = model.packages.filter((packageValue) =>
    packageValue.verification.consumerScript !== undefined
      && (smokePackageNames === undefined || smokePackageNames.has(packageValue.name)));
  const importOutput = await runConsumerChecks({
    importCheck: async () => {
      const start = performance.now();
      const output = await runCaptured(process.execPath, ['verify.mjs'], { cwd: consumerRoot });
      process.stdout.write(`pack:check consumer imports: ${((performance.now() - start) / 1_000).toFixed(2)}s\n`);
      return output;
    },
    smokeChecks: async () => {
      const start = performance.now();
      await runBounded(smokes, packageConcurrency, async (packageValue) => {
        const targetRoot = resolve(consumerRoot, 'package-consumers', packageSlug(packageValue.name));
        await cp(resolve(packageValue.packageRoot, 'package-consumer'), targetRoot, { recursive: true });
        await runCaptured(process.execPath, ['verify.mjs'], {
          cwd: targetRoot,
          env: {
            ...process.env,
            PACKAGE_CONSUMER_BINARIES: JSON.stringify(binaries),
            PACKAGE_CONSUMER_ROOT: consumerRoot,
          },
        });
      });
      process.stdout.write(`pack:check consumer smokes: ${((performance.now() - start) / 1_000).toFixed(2)}s\n`);
    },
  });
  return `${importOutput}\nClean package consumer executed discovered smoke fixtures.`;
};

export const verifyLocalPackages = async ({ repositoryRoot, verificationRoot, tarballCacheRoot, onBuilt }) => {
  if (relative(repositoryRoot, verificationRoot).startsWith('..')) {
    throw new Error('package verification directory escaped the repository');
  }
  await rm(verificationRoot, { force: true, recursive: true });
  let phaseStart = performance.now();
  const reportPhase = (name) => {
    const now = performance.now();
    process.stdout.write(`pack:check ${name}: ${((now - phaseStart) / 1_000).toFixed(2)}s\n`);
    phaseStart = now;
  };
  try {
    const model = await discoverWorkspacePackageModel({ repositoryRoot });
    await verifyRepositoryHygiene(repositoryRoot);
    await verifyDocumentationLinks(repositoryRoot);
    for (const packageValue of model.packages) await verifyManifest(packageValue, model.rootManifest);
    reportPhase('metadata');
    await preparePackagesForPacking({ model });
    reportPhase('build');
    onBuilt?.();
    const { extractedPackages, tarballs } = await packPackages(model, verificationRoot);
    await verifyBrowserBoundaries(extractedPackages);
    reportPhase('tarballs and browser boundaries');
    const consumerRoot = resolve(verificationRoot, 'consumer');
    const references = new Map(model.packages.map(({ name }) => {
      const tarball = tarballs.get(name);
      return [name, `file:${relative(consumerRoot, tarball).replaceAll('\\', '/')}`];
    }));
    process.stdout.write(`${await runCleanPackageConsumer({ consumerRoot, model, references })}\n`);
    reportPhase('clean consumer');
    if (tarballCacheRoot !== undefined) {
      await mkdir(tarballCacheRoot, { recursive: true });
      const manifest = {};
      for (const [name, tarball] of tarballs) {
        const filename = basename(tarball);
        await copyFile(tarball, resolve(tarballCacheRoot, filename));
        manifest[name] = filename;
      }
      await writeFile(resolve(tarballCacheRoot, 'tarballs.json'),
        `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    }
    reportPhase('tarball cache');
  } finally {
    await rm(verificationRoot, { force: true, recursive: true });
  }
};
