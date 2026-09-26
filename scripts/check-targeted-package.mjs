import { relative, resolve } from 'node:path';

import { packPackages, runCleanPackageConsumer, verifyManifest } from './package-consumer-runner.mjs';
import { verifyBrowserBoundaries } from './package-verification.mjs';

export const planTargetPackages = (model, packageNames) => {
  const byName = new Map(model.packages.map((value) => [value.name, value]));
  const selected = new Set();
  const visit = (name) => {
    if (selected.has(name)) return;
    const packageValue = byName.get(name);
    if (!packageValue) throw new Error(`unknown workspace package: ${name}`);
    selected.add(name);
    for (const dependency of packageValue.workspaceDependencies) visit(dependency);
  };
  for (const packageName of packageNames) visit(packageName);
  const packages = model.packages.filter(({ name }) => selected.has(name));
  return { packages, smokePackageNames: new Set(packageNames) };
};

export const verifyTargetedPackages = async ({ model, packageNames, verificationRoot, reusedTarballs }) => {
  const { packages, smokePackageNames } = planTargetPackages(model, packageNames);
  const subset = { ...model, packages };
  for (const packageValue of packages) await verifyManifest(packageValue, model.rootManifest);
  const { extractedPackages, tarballs } = await packPackages(subset, verificationRoot, { reusedTarballs });
  await verifyBrowserBoundaries(extractedPackages);
  const consumerRoot = resolve(verificationRoot, 'consumer');
  const references = new Map(packages.map(({ name }) => [name,
    `file:${relative(consumerRoot, tarballs.get(name)).replaceAll('\\', '/')}`]));
  await runCleanPackageConsumer({ consumerRoot, model: subset, references,
    smokePackageNames });
  return { targetTarballs: new Map(packageNames.map((name) => [name, tarballs.get(name)])) };
};
