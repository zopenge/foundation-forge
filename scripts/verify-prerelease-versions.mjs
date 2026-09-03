import { fileURLToPath } from 'node:url';

import {
  assertTrustedPublishingReady,
  hasPrereleaseVersion,
} from './release-plan.mjs';
import { loadReleasePolicy } from './release-policy.mjs';
import { discoverWorkspacePackageModel } from './workspace-packages.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const [policy, workspace] = await Promise.all([
  loadReleasePolicy(repositoryRoot),
  discoverWorkspacePackageModel({ repositoryRoot }),
]);
const packages = workspace.packages.map(({ name, version }) => ({ name, version }));

const packageStates = await Promise.all(packages.map(async (manifest) => {
  const response = await globalThis.fetch(
    `${policy.registry}/${encodeURIComponent(manifest.name)}`,
    { headers: { accept: 'application/json' } },
  );
  if (response.status === 404) {
    return { ...manifest, versions: new Set() };
  }
  if (!response.ok) {
    throw new Error(`npm registry returned ${response.status} for ${manifest.name}`);
  }
  const metadata = await response.json();
  if (metadata == null || typeof metadata !== 'object' || metadata.versions == null || typeof metadata.versions !== 'object') {
    throw new Error(`npm registry returned invalid version metadata for ${manifest.name}`);
  }
  return { ...manifest, versions: new Set(Object.keys(metadata.versions)) };
}));

if (!hasPrereleaseVersion(packages)) {
  throw new Error('At least one publishable package must use a prerelease version');
}

assertTrustedPublishingReady(packageStates);

console.log('Repository contains publishable prerelease versions and every package is bootstrapped.');
