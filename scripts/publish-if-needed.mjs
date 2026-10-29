import { mkdir, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import {
  assertBootstrapReleasePlan,
  assertNextReleasePlan,
  assertTrustedPublishingReady,
  createNpmPublishArguments,
  createReleasePlan,
  executeReleasePlan,
} from './release-plan.mjs';
import { createChangesetsOutputReporter } from './changesets-output.mjs';
import {
  createPackageManagerInvocation,
  findNpmCliPath,
} from './package-manager-command.mjs';
import { loadReleasePolicy } from './release-policy.mjs';
import { createNpmEnvironment } from './release-environment.mjs';
import { npmAuthenticationArguments } from './release-authentication.mjs';
import { discoverWorkspacePackageModel } from './workspace-packages.mjs';
import { assertFullCheckReceipt } from './check-release-gate.mjs';

export const publishIfNeeded = async ({ tag, bootstrap = false, model, policy,
  environment = process.env, onPublishState, expectedNames, authMode = 'otp',
} = {}) => {
  const authenticationArguments = npmAuthenticationArguments(authMode);
  if (authMode === 'web' && !bootstrap) throw new Error('WEB_AUTH_BOOTSTRAP_ONLY');
  const repositoryRoot = model?.repositoryRoot ?? fileURLToPath(new URL('../', import.meta.url));
  await assertFullCheckReceipt(repositoryRoot);
  const packDirectory = resolve(repositoryRoot, '.tmp', 'release-packs');

  async function publishedVersions(packageName, registry) {
    const response = await globalThis.fetch(`${registry}/${encodeURIComponent(packageName)}`, {
      headers: { accept: 'application/json' },
      signal: globalThis.AbortSignal.timeout(30_000),
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

  function run(command, args, { cwd = repositoryRoot, env = environment } = {}) {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(command, args, { cwd, env, stdio: 'inherit', shell: false, windowsHide: true });
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

  const changesetsOutputReporter = await createChangesetsOutputReporter(
    process.env.CHANGESETS_OUTPUT,
  );

  async function runPackageManager(manager, args) {
    const invocation = createPackageManagerInvocation(manager, args, {
      npmCliPath: process.platform === 'win32' && manager === 'npm'
        ? findNpmCliPath()
        : undefined,
    });
    await run(invocation.command, invocation.args, {
      env: manager === 'npm' ? createNpmEnvironment(environment) : environment,
    });
  }

  async function packPackage(release) {
    await assertFullCheckReceipt(repositoryRoot);
    const before = new Set(await readdir(packDirectory));
    await runPackageManager('pnpm', [
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
    await assertFullCheckReceipt(repositoryRoot);
    const args = createNpmPublishArguments(tarball, {
      provenance: !bootstrap,
      tag,
    });
    await runPackageManager('npm', [...args, ...authenticationArguments]);
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
      await changesetsOutputReporter.recordGitTag(release);
      return;
    }
    await run('git', ['tag', tagName]);
    process.stdout.write(`New tag: ${tagName}\n`);
    await changesetsOutputReporter.recordGitTag(release);
  }

  async function verifyTag(release) {
    const tagName = `${release.name}@${release.version}`;
    const existing = await capture('git', ['rev-list', '-n', '1', tagName]);
    if (existing.code !== 0 || existing.stdout.trim() === '') {
      throw new Error(
        `Published version ${release.name}@${release.version} is missing Git tag ${tagName}`,
      );
    }
    process.stdout.write(`Existing tag: ${tagName}\n`);
  }

  if (bootstrap && tag !== 'next') {
    throw new Error('Bootstrap publishing requires --tag next');
  }

  const [resolvedPolicy, workspace] = await Promise.all([
    policy ?? loadReleasePolicy(repositoryRoot),
    model ?? discoverWorkspacePackageModel({ repositoryRoot }),
  ]);
  const packages = workspace.packages.map(({ name, version }) => ({ name, version }));
  const states = await Promise.all(packages.map(async (packageJson) => ({
    ...packageJson,
    versions: await publishedVersions(packageJson.name, resolvedPolicy.registry),
  })));
  const releasePlan = createReleasePlan(states);
  if (bootstrap) {
    assertBootstrapReleasePlan(releasePlan);
  } else {
    assertTrustedPublishingReady(states);
    if (tag === 'next') {
      assertNextReleasePlan(releasePlan);
    }
  }
  const unpublished = releasePlan.filter((release) => release.needsPublish);
  if (expectedNames && JSON.stringify(unpublished.map(({ name }) => name).sort()) !== JSON.stringify([...expectedNames].sort())) {
    throw new Error('BOOTSTRAP_TARGETS_CHANGED：预检后 registry 状态变化，尚未 publish');
  }

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
      verifyTag,
      onPublishState,
    });
  } finally {
    await rm(packDirectory, { force: true, recursive: true });
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tagIndex = process.argv.indexOf('--tag');
  const tag = tagIndex === -1 ? undefined : process.argv[tagIndex + 1];
  if (tagIndex !== -1 && !tag) throw new Error('Missing value for --tag');
  await publishIfNeeded({ tag, bootstrap: process.argv.includes('--bootstrap') });
}
