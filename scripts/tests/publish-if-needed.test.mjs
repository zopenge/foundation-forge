import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import { createChangesetsOutputReporter } from '../changesets-output.mjs';
import { parseOneTimePassword } from '../bootstrap-otp.mjs';
import {
  createPackageManagerInvocation,
  extractPnpmCliPathFromWindowsShim,
  findPnpmCliPath,
} from '../package-manager-command.mjs';
import {
  assertBootstrapReleasePlan,
  assertNextReleasePlan,
  assertTrustedPublishingReady,
  createReleasePlan,
  createNpmPublishArguments,
  executeReleasePlan,
  hasPrereleaseVersion,
} from '../release-plan.mjs';

test('writes Changesets v2 git-tag events to the configured output file', async (context) => {
  const outputPath = resolve('.tmp', `changesets-output-${randomUUID()}.ndjson`);
  context.after(async () => rm(outputPath, { force: true }));
  const reporter = await createChangesetsOutputReporter(outputPath);

  await reporter.recordGitTag({ name: '@openge/example', version: '1.2.3' });

  assert.equal(
    await readFile(outputPath, 'utf8'),
    '{"type":"git-tag","tag":"@openge/example@1.2.3","packageName":"@openge/example"}\n',
  );
});

test('does not require a Changesets output file outside the action', async () => {
  const reporter = await createChangesetsOutputReporter(undefined);
  await reporter.recordGitTag({ name: '@openge/example', version: '1.2.3' });
});

test('accepts only a six-digit bootstrap one-time password', () => {
  assert.equal(parseOneTimePassword('123456'), '123456');
  assert.throws(() => parseOneTimePassword('12345'), /six digits/u);
  assert.throws(() => parseOneTimePassword('12345x'), /six digits/u);
});

test('runs Windows pnpm through its JavaScript CLI instead of a cmd shim', () => {
  assert.deepEqual(createPackageManagerInvocation('pnpm', ['pack'], {
    nodeExecutable: 'C:\\node\\node.exe',
    platform: 'win32',
    pnpmCliPath: 'C:\\pnpm\\pnpm.cjs',
  }), {
    args: ['C:\\pnpm\\pnpm.cjs', 'pack'],
    command: 'C:\\node\\node.exe',
  });
});

test('resolves the pnpm JavaScript CLI from the Windows command shim', () => {
  const shim = String.raw`@IF EXIST "%~dp0\node.exe" (
  "%~dp0\node.exe" "%~dp0\.tools\pnpm\10.33.2\node_modules\pnpm\bin\pnpm.cjs" %*
)`;

  assert.equal(
    extractPnpmCliPathFromWindowsShim(shim, 'C:\\Users\\example\\AppData\\Local\\pnpm'),
    'C:\\Users\\example\\AppData\\Local\\pnpm\\.tools\\pnpm\\10.33.2\\node_modules\\pnpm\\bin\\pnpm.cjs',
  );
});

test('finds the installed pnpm JavaScript CLI on Windows', {
  skip: process.platform !== 'win32',
}, () => {
  assert.match(findPnpmCliPath(), /pnpm\.cjs$/iu);
});

test('runs Windows npm through its JavaScript CLI instead of a cmd shim', () => {
  assert.deepEqual(createPackageManagerInvocation('npm', ['publish'], {
    nodeExecutable: 'C:\\node\\node.exe',
    npmCliPath: 'C:\\node\\node_modules\\npm\\bin\\npm-cli.js',
    platform: 'win32',
  }), {
    args: ['C:\\node\\node_modules\\npm\\bin\\npm-cli.js', 'publish'],
    command: 'C:\\node\\node.exe',
  });
});

test('uses package-manager executables directly outside Windows', () => {
  assert.deepEqual(createPackageManagerInvocation('npm', ['publish'], {
    nodeExecutable: '/usr/bin/node',
    platform: 'linux',
  }), {
    args: ['publish'],
    command: 'npm',
  });
});

test('publishes only missing versions and verifies tags for published versions', async () => {
  const plan = createReleasePlan([
    { name: '@openge/core', version: '0.1.0', versions: new Set(['0.1.0']) },
    { name: '@openge/provider', version: '0.1.0', versions: new Set() },
  ]);
  const calls = [];

  await executeReleasePlan(plan, {
    ensureTag: async (release) => calls.push(`tag:${release.name}@${release.version}`),
    pack: async (release) => {
      calls.push(`pack:${release.name}`);
      return `${release.name.slice(1).replace('/', '-')}.tgz`;
    },
    publish: async (tarball, tag) => calls.push(`publish:${tarball}:${tag}`),
    tag: 'next',
    verifyTag: async (release) => calls.push(`verify:${release.name}@${release.version}`),
  });

  assert.deepEqual(calls, [
    'verify:@openge/core@0.1.0',
    'pack:@openge/provider',
    'publish:openge-provider.tgz:next',
    'tag:@openge/provider@0.1.0',
  ]);
});

test('fails instead of guessing a tag commit for a published version', async () => {
  const plan = createReleasePlan([
    { name: '@openge/core', version: '0.1.0', versions: new Set(['0.1.0']) },
    { name: '@openge/provider', version: '0.1.0', versions: new Set() },
  ]);
  const calls = [];

  await assert.rejects(executeReleasePlan(plan, {
    ensureTag: async (release) => calls.push(`tag:${release.name}`),
    pack: async (release) => {
      calls.push(`pack:${release.name}`);
      return `${release.name}.tgz`;
    },
    publish: async () => calls.push('publish'),
    tag: undefined,
    verifyTag: async (release) => {
      calls.push(`verify:${release.name}`);
      throw new Error('published version is missing its tag');
    },
  }), /published version is missing its tag/u);

  assert.deepEqual(calls, ['verify:@openge/core']);
});

test('allows published stable packages beside unpublished prereleases for the next tag', () => {
  const plan = createReleasePlan([
    { name: '@openge/stable', version: '0.1.0', versions: new Set(['0.1.0']) },
    { name: '@openge/candidate', version: '0.2.0-rc.1', versions: new Set(['0.2.0-rc.0']) },
  ]);

  assert.doesNotThrow(() => assertNextReleasePlan(plan));
  assert.equal(hasPrereleaseVersion(plan), true);
});

test('rejects unpublished stable versions from the next tag', () => {
  const plan = createReleasePlan([
    { name: '@openge/stable', version: '0.2.0', versions: new Set(['0.1.0']) },
  ]);

  assert.throws(
    () => assertNextReleasePlan(plan),
    /@openge\/stable@0\.2\.0 cannot be published with the next tag/u,
  );
  assert.equal(hasPrereleaseVersion(plan), false);
});

test('rejects workflow publishing before a package has been bootstrapped', () => {
  const packageStates = [
    { name: '@openge/existing', version: '0.2.0-rc.1', versions: new Set(['0.1.0']) },
    { name: '@openge/new-package', version: '0.1.0-rc.0', versions: new Set() },
  ];

  assert.throws(
    () => assertTrustedPublishingReady(packageStates),
    /@openge\/new-package@0\.1\.0-rc\.0 must be bootstrapped before workflow publishing/u,
  );
});

test('allows workflow publishing after every package has a registry version', () => {
  const packageStates = [
    { name: '@openge/existing', version: '0.2.0-rc.1', versions: new Set(['0.1.0']) },
    { name: '@openge/new-package', version: '0.1.0-rc.1', versions: new Set(['0.1.0-rc.0']) },
  ];

  assert.doesNotThrow(() => assertTrustedPublishingReady(packageStates));
});

test('allows bootstrap publishing only for brand-new rc.0 packages', () => {
  const bootstrapPlan = createReleasePlan([
    { name: '@openge/existing', version: '0.1.0', versions: new Set(['0.1.0']) },
    { name: '@openge/new-package', version: '0.1.0-rc.0', versions: new Set() },
  ]);

  assert.doesNotThrow(() => assertBootstrapReleasePlan(bootstrapPlan));
  assert.throws(
    () => assertBootstrapReleasePlan(createReleasePlan([
      { name: '@openge/new-package', version: '0.1.0-rc.1', versions: new Set() },
    ])),
    /bootstrap publishing requires a brand-new rc\.0 package/u,
  );
  assert.throws(
    () => assertBootstrapReleasePlan(createReleasePlan([
      { name: '@openge/existing', version: '0.2.0-rc.0', versions: new Set(['0.1.0']) },
    ])),
    /bootstrap publishing requires a brand-new rc\.0 package/u,
  );
});

test('omits provenance only for the explicit bootstrap publication', () => {
  assert.deepEqual(createNpmPublishArguments('package.tgz', { tag: 'next' }), [
    'publish',
    'package.tgz',
    '--access',
    'public',
    '--provenance',
    '--tag',
    'next',
  ]);
  assert.deepEqual(createNpmPublishArguments('package.tgz', {
    provenance: false,
    tag: 'next',
  }), [
    'publish',
    'package.tgz',
    '--access',
    'public',
    '--tag',
    'next',
  ]);
});

test('does not create a tag or continue when publication fails', async () => {
  const plan = createReleasePlan([
    { name: '@openge/core', version: '0.1.0', versions: new Set() },
    { name: '@openge/provider', version: '0.1.0', versions: new Set() },
  ]);
  const calls = [];

  await assert.rejects(executeReleasePlan(plan, {
    ensureTag: async (release) => calls.push(`tag:${release.name}`),
    pack: async (release) => {
      calls.push(`pack:${release.name}`);
      return `${release.name}.tgz`;
    },
    publish: async () => {
      calls.push('publish');
      throw new Error('publish failed');
    },
    tag: undefined,
    verifyTag: async () => undefined,
  }), /publish failed/u);

  assert.deepEqual(calls, ['pack:@openge/core', 'publish']);
});
