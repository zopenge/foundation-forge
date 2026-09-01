import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createReleasePlan,
  executeReleasePlan,
} from '../release-plan.mjs';

test('publishes only missing versions in declaration order and creates every local tag', async () => {
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
  });

  assert.deepEqual(calls, [
    'tag:@openge/core@0.1.0',
    'pack:@openge/provider',
    'publish:openge-provider.tgz:next',
    'tag:@openge/provider@0.1.0',
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
  }), /publish failed/u);

  assert.deepEqual(calls, ['pack:@openge/core', 'publish']);
});
