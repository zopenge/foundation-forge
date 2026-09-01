import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const packageDirectories = [
  'packages/peer-network',
  'packages/peer-network-libp2p',
  'packages/peer-network-websocket',
];

async function readPackage(directory) {
  const packageJsonPath = resolve(directory, 'package.json');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  if (typeof packageJson.name !== 'string' || typeof packageJson.version !== 'string') {
    throw new Error(`Invalid package metadata: ${packageJsonPath}`);
  }
  return { name: packageJson.name, version: packageJson.version };
}

async function publishedVersions(packageName) {
  const response = await globalThis.fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`, {
    headers: { accept: 'application/json' },
  });
  if (response.status === 404) {
    return new Set();
  }
  if (!response.ok) {
    throw new Error(`npm registry returned ${response.status} for ${packageName}`);
  }
  const metadata = await response.json();
  if (metadata == null || typeof metadata !== 'object' || metadata.versions == null || typeof metadata.versions !== 'object') {
    throw new Error(`npm registry returned invalid version metadata for ${packageName}`);
  }
  return new Set(Object.keys(metadata.versions));
}

function runChangesets(tag) {
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const args = ['exec', 'changeset', 'publish'];
  if (tag) {
    args.push('--tag', tag);
  }
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', (code) => resolvePromise(code ?? 1));
  });
}

const tagIndex = process.argv.indexOf('--tag');
const tag = tagIndex === -1 ? undefined : process.argv[tagIndex + 1];
if (tagIndex !== -1 && !tag) {
  throw new Error('Missing value for --tag');
}

const packages = await Promise.all(packageDirectories.map(readPackage));
const states = await Promise.all(packages.map(async (packageJson) => ({
  ...packageJson,
  versions: await publishedVersions(packageJson.name),
})));
const unpublished = states.filter((state) => !state.versions.has(state.version));

if (unpublished.length === 0) {
  process.stdout.write('All local package versions are already published; skipping npm publish.\n');
  process.exit(0);
}

process.stdout.write(`Publishing ${unpublished.map(({ name, version }) => `${name}@${version}`).join(', ')}\n`);
process.exit(await runChangesets(tag));
