import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const defaults = Object.freeze({
  branch: 'main',
  environment: 'npm',
  npmTrustVersion: '11.19.1',
  pollIntervalMilliseconds: 2_000,
  pollTimeoutMilliseconds: 10 * 60_000,
  workflow: 'release.yml',
});

const parseGitHubRepository = (value) => {
  const match = value?.match(/github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?$/iu);
  if (match === null || match === undefined) throw new Error('root repository must be hosted on GitHub');
  return `${match[1]}/${match[2]}`;
};

const readRegistry = (npmrc) => {
  const line = npmrc.split(/\r?\n/u).find((candidate) => candidate.trim().startsWith('registry='));
  if (line === undefined) throw new Error('root .npmrc must declare the canonical registry');
  const registry = line.slice(line.indexOf('=') + 1).trim().replace(/\/+$/u, '');
  if (new URL(registry).hostname !== 'registry.npmjs.org') {
    throw new Error('release verification requires the canonical npm registry');
  }
  return registry;
};

export const loadReleasePolicy = async (repositoryRoot) => {
  const manifest = JSON.parse(await readFile(resolve(repositoryRoot, 'package.json'), 'utf8'));
  const npmrc = await readFile(resolve(repositoryRoot, '.npmrc'), 'utf8');
  const packageManager = manifest.packageManager?.match(/^pnpm@(.+)$/u);
  if (packageManager === null || packageManager === undefined) {
    throw new Error('root packageManager must pin pnpm');
  }
  const url = typeof manifest.repository === 'string'
    ? manifest.repository
    : manifest.repository?.url;
  return {
    ...defaults,
    githubRepository: parseGitHubRepository(url),
    pnpmVersion: packageManager[1],
    registry: readRegistry(npmrc),
  };
};

export const releasePolicyDefaults = defaults;
