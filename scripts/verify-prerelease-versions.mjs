import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { hasPrereleaseVersion } from './release-plan.mjs';
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

if (!hasPrereleaseVersion(packages)) {
  throw new Error('At least one publishable package must use a prerelease version');
}

console.log('Repository contains publishable prerelease versions.');
