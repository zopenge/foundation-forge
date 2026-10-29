import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import { basename, delimiter, relative, resolve } from 'node:path';

const sha = (value) => createHash('sha256').update(value).digest('hex');

const fileDigest = async (path) => {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) return sha(`link:${await readlink(path)}`);
  if (!metadata.isFile()) throw new Error(`unsupported check input: ${path}`);
  return sha(await readFile(path));
};

export const collectWorkspaceFingerprint = async (repositoryRoot) => {
  const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: repositoryRoot, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024,
  });
  if (listed.status !== 0) throw new Error('check input enumeration failed');
  const paths = [...new Set(listed.stdout.split('\0').filter(Boolean))].sort();
  if (paths.length === 0) throw new Error('check input enumeration was empty');
  const entries = await Promise.all(paths.map(async (path) => {
    let digest;
    try { digest = await fileDigest(resolve(repositoryRoot, path)); }
    catch (error) { if (error?.code === 'ENOENT') digest = null; else throw error; }
    return [path.replaceAll('\\', '/'), digest];
  }));
  const files = Object.fromEntries(entries);
  const modulesPath = resolve(repositoryRoot, 'node_modules', '.modules.yaml');
  const environment = {
    node: process.version,
    executable: process.execPath,
    platform: process.platform,
    architecture: process.arch,
    // pnpm 嵌套 lifecycle 只会重复注入相同路径；保留首次顺序和每项原文，仍区分实际查找顺序。
    path: process.env.PATH === undefined ? undefined : [...new Set(process.env.PATH.split(delimiter))],
    nodeOptions: process.env.NODE_OPTIONS,
    pnpmHome: process.env.PNPM_HOME,
    ci: process.env.CI,
    vitestMaxWorkers: process.env.VITEST_MAX_WORKERS,
    testWorkers: process.env.FORGE_CHECK_TEST_WORKERS,
    workerCeiling: process.env.FORGE_CHECK_WORKER_CEILING,
    temp: process.env.TEMP,
    tmp: process.env.TMP,
    installedModules: await fileDigest(modulesPath),
  };
  const selectionEnvironment = { ...environment };
  Reflect.deleteProperty(selectionEnvironment, 'vitestMaxWorkers'); Reflect.deleteProperty(selectionEnvironment, 'testWorkers');
  Reflect.deleteProperty(selectionEnvironment, 'workerCeiling');
  // quick 的影响选择不复用执行结论；full 发布收据仍绑定原始完整环境（含并发设置）。
  return { schemaVersion: 1, environmentDigest: sha(JSON.stringify(environment)),
    selectionEnvironmentDigest: sha(JSON.stringify(selectionEnvironment)), files };
};

export const collectDistDigests = async (packages) => Object.fromEntries(await Promise.all(
  packages.map(async (packageValue) => {
    const root = resolve(packageValue.packageRoot, 'dist');
    const rows = [];
    const visit = async (directory) => {
      for (const entry of (await readdir(directory, { withFileTypes: true }))
        .sort((left, right) => left.name.localeCompare(right.name))) {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) await visit(path);
        else rows.push([relative(root, path).replaceAll('\\', '/'), await fileDigest(path)]);
      }
    };
    await visit(root);
    if (rows.length === 0) throw new Error(`missing built output: ${packageValue.name}`);
    return [packageValue.name, sha(JSON.stringify(rows))];
  }),
));

export const collectTarballDigests = async (packages, tarballCacheRoot) => {
  const manifest = JSON.parse(await readFile(resolve(tarballCacheRoot, 'tarballs.json'), 'utf8'));
  const names = packages.map(({ name }) => name);
  if (Object.keys(manifest).length !== names.length || names.some((name) => !(name in manifest)))
    throw new Error('verified tarball cache does not cover the workspace');
  return Object.fromEntries(await Promise.all(names.map(async (name) => {
    const filename = manifest[name];
    if (typeof filename !== 'string' || basename(filename) !== filename
      || filename === '.' || filename === '..' || !filename.endsWith('.tgz'))
      throw new Error(`invalid cached tarball path for ${name}`);
    return [name, { filename, sha256: await fileDigest(resolve(tarballCacheRoot, filename)) }];
  })));
};
