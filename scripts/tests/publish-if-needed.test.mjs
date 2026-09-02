import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertNextReleasePlan,
  createReleasePlan,
  executeReleasePlan,
  hasPrereleaseVersion,
} from '../release-plan.mjs';
import { releasePackageDirectories } from '../release-package-directories.mjs';

test('declares every public package in dependency-safe release order', () => {
  assert.deepEqual(releasePackageDirectories, [
    'packages/peer-network',
    'packages/peer-network-libp2p',
    'packages/peer-network-websocket',
    'packages/repository-files',
    'packages/deterministic-json',
    'packages/path-safety',
    'packages/artifact-integrity',
    'packages/archive-safety',
    'packages/text-integrity',
  ]);
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
