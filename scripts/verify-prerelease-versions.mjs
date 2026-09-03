import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  assertTrustedPublishingReady,
  hasPrereleaseVersion,
} from './release-plan.mjs';
import { releasePackageDirectories } from './release-package-directories.mjs';

const packages = [];
for (const directory of releasePackageDirectories) {
  const relativePath = `../${directory}/package.json`;
  const path = fileURLToPath(new URL(relativePath, import.meta.url));
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    throw new Error(`Invalid package metadata: ${relativePath}`);
  }
  packages.push({ name: manifest.name, version: manifest.version });
}

const packageStates = await Promise.all(packages.map(async (manifest) => {
  const response = await globalThis.fetch(
    `https://registry.npmjs.org/${encodeURIComponent(manifest.name)}`,
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
