import { relative, resolve } from 'node:path';

import { packPackages, runCleanPackageConsumer, verifyManifest } from './package-consumer-runner.mjs';
import { verifyBrowserBoundaries } from './package-verification.mjs';
import { prepareConsumerPackages } from './consumer-package-selection.mjs';

export { planConsumerPackages as planTargetPackages } from './consumer-package-selection.mjs';

export const verifyTargetedPackages = async ({ model, packageNames, verificationRoot, reusedTarballs, testRun }) => {
  const { packages, smokePackageNames } = await prepareConsumerPackages(model, packageNames);
  const subset = { ...model, packages };
  for (const packageValue of packages) await verifyManifest(packageValue, model.rootManifest);
  const { extractedPackages, tarballs } = await packPackages(subset, verificationRoot, { reusedTarballs });
  await verifyBrowserBoundaries(extractedPackages);
  const consumerRoot = resolve(verificationRoot, 'consumer');
  const references = new Map(packages.map(({ name }) => [name,
    `file:${relative(consumerRoot, tarballs.get(name)).replaceAll('\\', '/')}`]));
  await runCleanPackageConsumer({ consumerRoot, model: subset, references,
    smokePackageNames, testRun });
  return { targetTarballs: new Map(packageNames.map((name) => [name, tarballs.get(name)])) };
};
