import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { createReleasePlan, executeReleasePlan } from './release-plan.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const packDirectory = resolve(repositoryRoot, '.tmp', 'release-packs');

const packageDirectories = [
  'packages/peer-network',
  'packages/peer-network-libp2p',
  'packages/peer-network-websocket',
];

async function readPackage(directory) {
  const packageJsonPath = resolve(repositoryRoot, directory, 'package.json');
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

function run(command, args, { cwd = repositoryRoot } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`${command} exited with code ${String(code ?? 1)}`));
      }
    });
  });
}

function capture(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
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
    child.once('exit', (code) => resolvePromise({ code: code ?? 1, stderr, stdout }));
  });
}

const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

async function packPackage(release) {
  const before = new Set(await readdir(packDirectory));
  await run(pnpmCommand, [
    '--filter',
    release.name,
    'pack',
    '--pack-destination',
    packDirectory,
  ]);
  const created = (await readdir(packDirectory)).filter((name) => !before.has(name));
  if (created.length !== 1) {
    throw new Error(`${release.name} produced ${String(created.length)} release tarballs`);
  }
  return resolve(packDirectory, created[0]);
}

async function publishTarball(tarball, tag) {
  const args = ['publish', tarball, '--access', 'public', '--provenance'];
  if (tag !== undefined) {
    args.push('--tag', tag);
  }
  await run(npmCommand, args);
}

async function ensureTag(release) {
  const tagName = `${release.name}@${release.version}`;
  const existing = await capture('git', ['rev-list', '-n', '1', tagName]);
  const head = await capture('git', ['rev-parse', 'HEAD']);
  if (head.code !== 0) {
    throw new Error(head.stderr || 'Unable to resolve HEAD');
  }
  if (existing.code === 0) {
    if (existing.stdout.trim() !== head.stdout.trim()) {
      throw new Error(`Git tag ${tagName} points to a different commit`);
    }
    process.stdout.write(`Existing tag: ${tagName}\n`);
    return;
  }
  await run('git', ['tag', tagName]);
  process.stdout.write(`New tag: ${tagName}\n`);
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
const releasePlan = createReleasePlan(states);
const unpublished = releasePlan.filter((release) => release.needsPublish);

if (unpublished.length === 0) {
  process.stdout.write('All local package versions are already published; ensuring Git tags.\n');
} else {
  process.stdout.write(`Publishing ${unpublished.map(({ name, version }) => `${name}@${version}`).join(', ')}\n`);
}

await rm(packDirectory, { force: true, recursive: true });
await mkdir(packDirectory, { recursive: true });
try {
  await executeReleasePlan(releasePlan, {
    ensureTag,
    pack: packPackage,
    publish: publishTarball,
    tag,
  });
} finally {
  await rm(packDirectory, { force: true, recursive: true });
}
