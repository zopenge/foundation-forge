import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { planConsumerPackages, prepareConsumerPackages } from '../consumer-package-selection.mjs';

test('multiple targets include shared dependencies once and smoke only the targets', () => {
  const packages = [
    { name: 'base', workspaceDependencies: [] },
    { name: 'core', workspaceDependencies: ['base'] },
    { name: 'leaf', workspaceDependencies: ['core'] },
    { name: 'other', workspaceDependencies: [] },
  ];
  const plan = planConsumerPackages({ packages }, ['core', 'leaf']);
  assert.deepEqual(plan.packages.map(({ name }) => name), ['base', 'core', 'leaf']);
  assert.deepEqual([...plan.smokePackageNames], ['core', 'leaf']);
  assert.throws(() => planConsumerPackages({ packages }, ['unknown']), /unknown workspace package/u);
});

test('consumer-only dependencies are packed without adding a runtime dependency or extra smoke', () => {
  const packages = [
    { name: 'base', workspaceDependencies: [] },
    { name: 'core', workspaceDependencies: ['base'], verification: { consumerDependencies: ['provider'] } },
    { name: 'provider', workspaceDependencies: ['base'] },
  ];
  const plan = planConsumerPackages({ packages }, ['core']);
  assert.deepEqual(plan.packages.map(({ name }) => name), ['base', 'core', 'provider']);
  assert.deepEqual([...plan.smokePackageNames], ['core']);
  assert.deepEqual(packages[1].workspaceDependencies, ['base']);
});

test('consumer preparation reads only the reachable formal metadata and includes transitive test dependencies', async context => {
  await mkdir(resolve('tmp/tests'), { recursive: true });
  const root = await mkdtemp(resolve('tmp/tests/consumer-select-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const packages = [];
  for (const [name, dependencies, consumerDependencies] of [['base', [], []], ['core', ['base'], ['provider']], ['provider', ['base'], []]]) {
    const packageRoot = resolve(root, name); await mkdir(packageRoot);
    await writeFile(resolve(packageRoot, 'package.verify.json'), JSON.stringify({ browserExports: [], consumerDependencies }));
    packages.push({ name, workspaceDependencies: dependencies, packageRoot, exports: [], bins: [] });
  }
  packages.push({ name: 'unrelated', workspaceDependencies: [] });
  const selected = await prepareConsumerPackages({ packages }, ['core']);
  assert.deepEqual(selected.packages.map(value => value.name), ['base', 'core', 'provider']);
  assert.deepEqual([...selected.smokePackageNames], ['core']);
  assert.deepEqual(packages[1].workspaceDependencies, ['base']);
});
