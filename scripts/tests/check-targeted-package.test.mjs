import assert from 'node:assert/strict';
import test from 'node:test';

import { planTargetPackages } from '../check-targeted-package.mjs';

test('multiple targets include shared dependencies once and smoke only the targets', () => {
  const packages = [
    { name: 'base', workspaceDependencies: [] },
    { name: 'core', workspaceDependencies: ['base'] },
    { name: 'leaf', workspaceDependencies: ['core'] },
    { name: 'other', workspaceDependencies: [] },
  ];
  const plan = planTargetPackages({ packages }, ['core', 'leaf']);
  assert.deepEqual(plan.packages.map(({ name }) => name), ['base', 'core', 'leaf']);
  assert.deepEqual([...plan.smokePackageNames], ['core', 'leaf']);
  assert.throws(() => planTargetPackages({ packages }, ['unknown']), /unknown workspace package/u);
});

test('consumer-only dependencies are packed without adding a runtime dependency or extra smoke', () => {
  const packages = [
    { name: 'base', workspaceDependencies: [] },
    { name: 'core', workspaceDependencies: ['base'], verification: { consumerDependencies: ['provider'] } },
    { name: 'provider', workspaceDependencies: ['base'] },
  ];
  const plan = planTargetPackages({ packages }, ['core']);
  assert.deepEqual(plan.packages.map(({ name }) => name), ['base', 'core', 'provider']);
  assert.deepEqual([...plan.smokePackageNames], ['core']);
  assert.deepEqual(packages[1].workspaceDependencies, ['base']);
});
