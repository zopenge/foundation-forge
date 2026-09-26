import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { orderCoveragePackages, runWorkspaceCoverage } from '../run-workspace-coverage.mjs';

test('coverage scheduling discovers test files and starts larger suites first', async () => {
  await mkdir(resolve('.tmp/tests'), { recursive: true });
  const root = await mkdtemp(resolve('.tmp/tests', 'coverage-order-'));
  try {
    const packages = await Promise.all(['small', 'large', 'none'].map(async (name) => {
      const packageRoot = resolve(root, name);
      await mkdir(resolve(packageRoot, 'tests'), { recursive: true });
      return { name, packageRoot, manifest: { scripts: { 'test:coverage': 'vitest run --coverage' } } };
    }));
    await writeFile(resolve(root, 'small', 'tests', 'a.test.ts'), 'export {};\n');
    await writeFile(resolve(root, 'large', 'tests', 'a.test.ts'), 'export {};\n');
    await writeFile(resolve(root, 'large', 'tests', 'b.test.ts'), 'export {};\n');
    await writeFile(resolve(root, 'large', 'tests', 'helper.ts'), 'export {};\n');
    const ordered = await orderCoveragePackages(packages);
    assert.deepEqual(ordered.map(({ name }) => name), ['large', 'small', 'none']);

    const started = [];
    await runWorkspaceCoverage({
      packages,
      concurrency: 2,
      run: async ({ name }) => { started.push(name); },
    });
    assert.deepEqual(started, ['large', 'small', 'none']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('default coverage scheduling runs no more than two packages at once', async () => {
  await mkdir(resolve('.tmp/tests'), { recursive: true });
  const root = await mkdtemp(resolve('.tmp/tests', 'coverage-concurrency-'));
  try {
    const packages = await Promise.all(['one', 'two', 'three'].map(async (name) => {
      const packageRoot = resolve(root, name);
      await mkdir(packageRoot, { recursive: true });
      return { name, packageRoot,
        manifest: { scripts: { 'test:coverage': 'vitest run --coverage' } } };
    }));
    let active = 0;
    let maximum = 0;
    await runWorkspaceCoverage({ packages, run: async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await delay(20);
      active -= 1;
    } });
    assert.equal(maximum, Math.min(2, availableParallelism()));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
