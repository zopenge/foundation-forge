import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import { createPackageManagerInvocation } from './package-manager-command.mjs';

const dependencyKinds = Object.freeze([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]);

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

export const parseJsonDocuments = (value) => {
  const documents = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (start === -1) {
      if (character === '{' || character === '[') {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{' || character === '[') depth += 1;
    else if (character === '}' || character === ']') {
      depth -= 1;
      if (depth === 0) {
        documents.push(JSON.parse(value.slice(start, index + 1)));
        start = -1;
      }
    }
  }
  if (start !== -1) throw new Error('package manager returned incomplete JSON output');
  return documents;
};

const capturePnpmOutput = (repositoryRoot) => new Promise((resolvePromise, reject) => {
  const invocation = createPackageManagerInvocation('pnpm', [
    'list',
    '--recursive',
    '--depth',
    '-1',
    '--json',
  ]);
  const child = spawn(invocation.command, invocation.args, {
    cwd: repositoryRoot,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', reject);
  child.once('exit', (code) => {
    if (code === 0) resolvePromise(stdout);
    else reject(new Error(stderr || `pnpm list exited with code ${String(code ?? 1)}`));
  });
});

const normalizeExportTarget = (packageName, subpath, target) => {
  if (typeof target === 'string') {
    return { importTarget: target, typesTarget: undefined };
  }
  if (target == null || typeof target !== 'object' || Array.isArray(target)) {
    throw new Error(`${packageName} export ${subpath} has an invalid target`);
  }
  const importTarget = target.import ?? target.default;
  if (typeof importTarget !== 'string') {
    throw new Error(`${packageName} export ${subpath} has no import target`);
  }
  if (target.types !== undefined && typeof target.types !== 'string') {
    throw new Error(`${packageName} export ${subpath} has an invalid types target`);
  }
  return { importTarget, typesTarget: target.types };
};

export const normalizePackageExports = (packageName, exportsField) => {
  if (exportsField == null || typeof exportsField !== 'object' || Array.isArray(exportsField)) {
    throw new Error(`${packageName} must declare explicit package exports`);
  }
  return Object.entries(exportsField).sort(([left], [right]) => left.localeCompare(right)).map(
    ([subpath, target]) => {
      if (!subpath.startsWith('.') || subpath.includes('*')) {
        throw new Error(`${packageName} uses unsupported wildcard exports or export keys`);
      }
      const { importTarget, typesTarget } = normalizeExportTarget(packageName, subpath, target);
      if (importTarget.includes('*') || typesTarget?.includes('*')) {
        throw new Error(`${packageName} uses unsupported wildcard exports`);
      }
      return {
        importTarget,
        specifier: subpath === '.' ? packageName : `${packageName}${subpath.slice(1)}`,
        subpath,
        typesTarget,
      };
    },
  );
};

export const normalizePackageBins = (packageName, binField) => {
  if (binField === undefined) return [];
  const unscopedName = packageName.split('/').at(-1);
  const entries = typeof binField === 'string'
    ? [[unscopedName, binField]]
    : Object.entries(binField ?? {});
  return entries.sort(([left], [right]) => left.localeCompare(right)).map(([name, target]) => {
    if (typeof name !== 'string' || name.length === 0 || typeof target !== 'string') {
      throw new Error(`${packageName} has an invalid bin declaration`);
    }
    return { name, target };
  });
};

const collectDependencyNames = (manifest) => {
  const names = new Set();
  for (const kind of dependencyKinds) {
    const dependencies = manifest[kind];
    if (dependencies === undefined) continue;
    if (dependencies == null || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
      throw new Error(`${manifest.name} has invalid ${kind}`);
    }
    for (const [name, version] of Object.entries(dependencies)) {
      if (typeof version !== 'string') throw new Error(`${manifest.name} has invalid ${kind}`);
      names.add(name);
    }
  }
  return names;
};

const sortPackages = (packages) => {
  const byName = new Map(packages.map((value) => [value.name, value]));
  const dependants = new Map(packages.map(({ name }) => [name, []]));
  const indegree = new Map(packages.map(({ name, workspaceDependencies }) => [
    name,
    workspaceDependencies.length,
  ]));
  for (const packageValue of packages) {
    for (const dependency of packageValue.workspaceDependencies) {
      dependants.get(dependency).push(packageValue.name);
    }
  }
  for (const values of dependants.values()) values.sort((left, right) => left.localeCompare(right));

  const ready = packages
    .filter(({ name }) => indegree.get(name) === 0)
    .map(({ name }) => name)
    .sort((left, right) => left.localeCompare(right));
  const sorted = [];
  while (ready.length > 0) {
    const name = ready.shift();
    sorted.push(byName.get(name));
    for (const dependant of dependants.get(name)) {
      const next = indegree.get(dependant) - 1;
      indegree.set(dependant, next);
      if (next === 0) {
        ready.push(dependant);
        ready.sort((left, right) => left.localeCompare(right));
      }
    }
  }
  if (sorted.length !== packages.length) {
    const members = packages
      .map(({ name }) => name)
      .filter((name) => indegree.get(name) > 0)
      .sort();
    throw new Error(`workspace package dependency cycle: ${members.join(', ')}`);
  }
  return sorted;
};

export const createWorkspacePackageModel = async ({ listing, repositoryRoot }) => {
  const root = resolve(repositoryRoot);
  const rootManifest = await readJson(resolve(root, 'package.json'));
  const candidates = listing.filter((entry) => resolve(entry.path) !== root);
  const packages = [];
  const names = new Set();
  for (const candidate of candidates) {
    const packageRoot = resolve(candidate.path);
    const manifest = await readJson(resolve(packageRoot, 'package.json'));
    if (manifest.private === true) continue;
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
      throw new Error(`invalid workspace package manifest: ${packageRoot}`);
    }
    if (names.has(manifest.name)) {
      throw new Error(`duplicate workspace package name: ${manifest.name}`);
    }
    names.add(manifest.name);
    packages.push({
      bins: normalizePackageBins(manifest.name, manifest.bin),
      directory: relative(root, packageRoot).replaceAll('\\', '/'),
      exports: normalizePackageExports(manifest.name, manifest.exports),
      manifest,
      name: manifest.name,
      packageRoot,
      version: manifest.version,
    });
  }
  for (const packageValue of packages) {
    packageValue.workspaceDependencies = [...collectDependencyNames(packageValue.manifest)]
      .filter((name) => names.has(name))
      .sort((left, right) => left.localeCompare(right));
  }
  return { packages: sortPackages(packages), repositoryRoot: root, rootManifest };
};

export const discoverWorkspacePackageModel = async ({
  capturePnpm = () => capturePnpmOutput(repositoryRoot),
  repositoryRoot,
}) => {
  const documents = parseJsonDocuments(await capturePnpm());
  const listing = documents.find((value) => Array.isArray(value));
  if (listing === undefined) throw new Error('pnpm list did not return a workspace package array');
  return createWorkspacePackageModel({ listing, repositoryRoot });
};

export const workspaceDependencyKinds = dependencyKinds;
