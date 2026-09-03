import { spawnSync } from 'node:child_process';
import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

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

const runPnpm = (args, options) => {
  const invocation = createPackageManagerInvocation('pnpm', args);
  return run(invocation.command, invocation.args, options);
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

const verifyDocumentationLinks = async (repositoryRoot) => {
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

const verifyManifest = async (packageValue, rootManifest) => {
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
  return entries;
};

const packageSlug = (name) => name.replace(/^@/u, '').replaceAll('/', '-');

const packPackages = async (model, verificationRoot) => {
  const packDirectory = resolve(verificationRoot, 'packs');
  const extractDirectory = resolve(verificationRoot, 'extracted');
  await mkdir(packDirectory, { recursive: true });
  await mkdir(extractDirectory, { recursive: true });
  const tarballs = new Map();
  const extractedPackages = [];
  for (const packageValue of model.packages) {
    const before = new Set(await readdir(packDirectory));
    runPnpm(['--filter', packageValue.name, 'pack', '--pack-destination', packDirectory], {
      cwd: model.repositoryRoot,
    });
    const created = (await readdir(packDirectory)).filter((name) => !before.has(name));
    if (created.length !== 1) {
      throw new Error(`${packageValue.name} produced ${String(created.length)} tarballs`);
    }
    const tarballPath = resolve(packDirectory, created[0]);
    const entries = verifyTarball(packageValue, tarballPath, model.repositoryRoot);
    process.stdout.write(`${packageValue.name}: verified ${String(entries.length)} packed files\n`);
    tarballs.set(packageValue.name, tarballPath);
    const extractedRoot = resolve(extractDirectory, packageSlug(packageValue.name));
    await mkdir(extractedRoot, { recursive: true });
    run('tar', ['-xzf', tarballPath, '-C', extractedRoot], { cwd: model.repositoryRoot });
    extractedPackages.push({
      ...packageValue,
      packageRoot: resolve(extractedRoot, 'package'),
    });
  }
  return { extractedPackages, tarballs };
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

export const runCleanPackageConsumer = async ({
  consumerRoot,
  model,
  references,
}) => {
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
  const importOutput = run(process.execPath, ['verify.mjs'], { cwd: consumerRoot });

  const binaries = Object.fromEntries(model.packages.flatMap((packageValue) => packageValue.bins.map(
    ({ name, target }) => [name, resolve(packageInstallationPath(consumerRoot, packageValue.name), target)],
  )));
  for (const packageValue of model.packages) {
    if (packageValue.verification.consumerScript === undefined) continue;
    const targetRoot = resolve(consumerRoot, 'package-consumers', packageSlug(packageValue.name));
    await cp(resolve(packageValue.packageRoot, 'package-consumer'), targetRoot, { recursive: true });
    run(process.execPath, ['verify.mjs'], {
      cwd: targetRoot,
      env: {
        ...process.env,
        PACKAGE_CONSUMER_BINARIES: JSON.stringify(binaries),
        PACKAGE_CONSUMER_ROOT: consumerRoot,
      },
    });
  }
  return `${importOutput}\nClean package consumer executed discovered smoke fixtures.`;
};

export const verifyLocalPackages = async ({ repositoryRoot, verificationRoot }) => {
  if (relative(repositoryRoot, verificationRoot).startsWith('..')) {
    throw new Error('package verification directory escaped the repository');
  }
  await rm(verificationRoot, { force: true, recursive: true });
  try {
    const model = await discoverWorkspacePackageModel({ repositoryRoot });
    await verifyRepositoryHygiene(repositoryRoot);
    await verifyDocumentationLinks(repositoryRoot);
    for (const packageValue of model.packages) await verifyManifest(packageValue, model.rootManifest);
    await preparePackagesForPacking({ model });
    const { extractedPackages, tarballs } = await packPackages(model, verificationRoot);
    await verifyBrowserBoundaries(extractedPackages);
    const consumerRoot = resolve(verificationRoot, 'consumer');
    const references = new Map(model.packages.map(({ name }) => {
      const tarball = tarballs.get(name);
      return [name, `file:${relative(consumerRoot, tarball).replaceAll('\\', '/')}`];
    }));
    process.stdout.write(`${await runCleanPackageConsumer({ consumerRoot, model, references })}\n`);
  } finally {
    await rm(verificationRoot, { force: true, recursive: true });
  }
};
