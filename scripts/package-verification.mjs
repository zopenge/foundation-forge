import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const consumerScriptName = 'package-consumer/verify.mjs';

const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

export const loadPackageVerification = async (packageValue) => {
  const configurationPath = resolve(packageValue.packageRoot, 'package.verify.json');
  let configuration;
  try {
    configuration = JSON.parse(await readFile(configurationPath, 'utf8'));
  } catch (error) {
    throw new Error(`${packageValue.name} requires a valid package.verify.json`, { cause: error });
  }
  if (
    configuration == null
    || typeof configuration !== 'object'
    || Array.isArray(configuration)
    || !Array.isArray(configuration.browserExports)
    || configuration.browserExports.some((value) => typeof value !== 'string')
  ) {
    throw new Error(`${packageValue.name} package.verify.json must declare browserExports`);
  }
  const exportNames = new Set(packageValue.exports.map(({ subpath }) => subpath));
  const browserExports = [...new Set(configuration.browserExports)].sort();
  for (const subpath of browserExports) {
    if (!exportNames.has(subpath)) {
      throw new Error(`${packageValue.name} declares unknown browser export ${subpath}`);
    }
  }
  const candidate = resolve(packageValue.packageRoot, consumerScriptName);
  const consumerScript = await exists(candidate) ? candidate : undefined;
  if (packageValue.bins.length > 0 && consumerScript === undefined) {
    throw new Error(`${packageValue.name} exposes a binary and requires a consumer smoke`);
  }
  return { browserExports, consumerScript };
};

const importSpecifierPattern = /(?:\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\))/gu;

const readImportSpecifiers = (source) => [...source.matchAll(importSpecifierPattern)]
  .map((match) => match[1] ?? match[2]);

export const verifyBrowserBoundaries = async (packages) => {
  const exportsBySpecifier = new Map();
  const packagesByName = new Map();
  for (const packageValue of packages) {
    packagesByName.set(packageValue.name, packageValue);
    for (const entry of packageValue.exports) {
      exportsBySpecifier.set(entry.specifier, { entry, packageValue });
    }
  }
  const visited = new Set();
  const visit = async (packageValue, path, chain) => {
    const key = `${packageValue.name}:${path}`;
    if (visited.has(key)) return;
    visited.add(key);
    const source = await readFile(path, 'utf8');
    for (const specifier of readImportSpecifiers(source)) {
      if (specifier.startsWith('node:') || specifier === 'ws') {
        throw new Error(`${chain.join(' -> ')} imports forbidden browser dependency ${specifier}`);
      }
      if (specifier.startsWith('.')) {
        const target = resolve(dirname(path), specifier);
        await visit(packageValue, target, [...chain, specifier]);
        continue;
      }
      const workspaceExport = exportsBySpecifier.get(specifier);
      if (workspaceExport !== undefined) {
        await visit(
          workspaceExport.packageValue,
          resolve(workspaceExport.packageValue.packageRoot, workspaceExport.entry.importTarget),
          [...chain, specifier],
        );
        continue;
      }
      const workspacePackage = [...packagesByName.keys()].find(
        (name) => specifier === name || specifier.startsWith(`${name}/`),
      );
      if (workspacePackage !== undefined) {
        throw new Error(`${chain.join(' -> ')} imports unknown workspace export ${specifier}`);
      }
    }
  };

  for (const packageValue of packages) {
    for (const subpath of packageValue.verification.browserExports) {
      const entry = packageValue.exports.find((candidate) => candidate.subpath === subpath);
      await visit(
        packageValue,
        resolve(packageValue.packageRoot, entry.importTarget),
        [entry.specifier],
      );
    }
  }
};

export const createConsumerConfiguration = ({ packages, references }) => {
  const entries = [...packages]
    .sort(({ name: left }, { name: right }) => left.localeCompare(right))
    .map(({ name }) => {
      const reference = references.get(name);
      if (typeof reference !== 'string') throw new Error(`missing consumer reference for ${name}`);
      return [name, reference];
    });
  const dependencies = Object.fromEntries(entries);
  return { dependencies, overrides: { ...dependencies } };
};

export const createConsumerImportScript = (packages) => {
  const specifiers = packages.flatMap(({ exports }) => exports.map(({ specifier }) => specifier));
  return [
    ...specifiers.sort((left, right) => left.localeCompare(right)).map(
      (specifier) => `await import(${JSON.stringify(specifier)});`,
    ),
    "console.log('Clean package consumer imported every public entry.');",
    '',
  ].join('\n');
};

export const createPnpmWorkspaceConfiguration = (baseConfiguration, overrides) => [
  baseConfiguration.trimEnd(),
  '',
  'overrides:',
  ...Object.entries(overrides)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, reference]) => `  ${JSON.stringify(name)}: ${JSON.stringify(reference)}`),
  '',
].join('\n');
