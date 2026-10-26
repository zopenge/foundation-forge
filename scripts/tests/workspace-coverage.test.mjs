import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { orderCoveragePackages, publishCoverageReports, runWorkspaceCoverage } from '../run-workspace-coverage.mjs';
import { createTestWorkerBudget } from '../test-worker-budget.mjs';

const publicationFixture = async t => {
  await mkdir(resolve('.tmp/tests'), { recursive: true });
  const root = await mkdtemp(resolve('.tmp/tests', 'coverage-publication-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const reports = await Promise.all(['a', 'b'].map(async name => {
    const packageRoot = resolve(root, name), logRoot = resolve(root, 'jobs', name);
    await mkdir(resolve(packageRoot, 'coverage'), { recursive: true }); await mkdir(resolve(logRoot, 'coverage'), { recursive: true });
    await writeFile(resolve(packageRoot, 'coverage/old.txt'), name); await writeFile(resolve(logRoot, 'coverage/new.txt'), name);
    return { packageRoot, logRoot };
  }));
  await writeFile(resolve(root, 'coverage-summary.json'), 'old summary');
  return { root, reports, summary: ['new summary'] };
};
const assertOldPublication = async fixture => {
  for (const [index, report] of fixture.reports.entries()) {
    assert.equal(await readFile(resolve(report.packageRoot, 'coverage/old.txt'), 'utf8'), ['a', 'b'][index]);
    await assert.rejects(readFile(resolve(report.packageRoot, 'coverage/new.txt')), { code: 'ENOENT' });
  }
  assert.equal(await readFile(resolve(fixture.root, 'coverage-summary.json'), 'utf8'), 'old summary');
};

test('coverage publication installs every new report and its matching summary', async t => {
  const fixture = await publicationFixture(t);
  await publishCoverageReports(fixture);
  for (const [index, report] of fixture.reports.entries()) {
    assert.equal(await readFile(resolve(report.packageRoot, 'coverage/new.txt'), 'utf8'), ['a', 'b'][index]);
    await assert.rejects(readFile(resolve(report.packageRoot, 'coverage/old.txt')), { code: 'ENOENT' });
    assert.equal(await readFile(resolve(report.logRoot, 'coverage/new.txt'), 'utf8'), ['a', 'b'][index]);
  }
  assert.deepEqual(JSON.parse(await readFile(resolve(fixture.root, 'coverage-summary.json'), 'utf8')), fixture.summary);
});

test('coverage publication retains recovery data and reports both errors if rollback fails', async t => {
  const fixture = await publicationFixture(t), summaryTarget = resolve(fixture.root, 'coverage-summary.json');
  const primary = new Error('injected publication failure'), rollback = new Error('injected restoration failure');
  let injected = false;
  await assert.rejects(publishCoverageReports({ ...fixture, move: async (from, to) => {
    if (!injected && to === summaryTarget) { injected = true; throw primary; }
    if (injected && to === resolve(fixture.reports[0].packageRoot, 'coverage')) throw rollback;
    await rename(from, to);
  } }), error => error instanceof AggregateError && error.cause === primary && error.errors.includes(rollback));
  const staging = (await readdir(fixture.root)).find(value => value.startsWith('coverage-publish-'));
  assert.ok(staging);
  assert.equal(await readFile(resolve(fixture.root, staging, 'old/0/old.txt'), 'utf8'), 'a');
  assert.equal(await readFile(resolve(fixture.reports[1].packageRoot, 'coverage/old.txt'), 'utf8'), 'b');
  assert.equal(await readFile(summaryTarget, 'utf8'), 'old summary');
});

test('coverage publication preserves old reports when summary writing fails', async t => {
  const fixture = await publicationFixture(t), failure = Object.assign(new Error('injected write failure'), { code: 'EIO' });
  await assert.rejects(publishCoverageReports({ ...fixture, write: async () => { throw failure; } }), error => error === failure);
  await assertOldPublication(fixture);
});

test('coverage publication rolls every report back when the final summary replacement fails', async t => {
  const fixture = await publicationFixture(t), target = resolve(fixture.root, 'coverage-summary.json');
  const failure = Object.assign(new Error('injected replacement failure'), { code: 'EIO' });
  let injected = false;
  await assert.rejects(publishCoverageReports({ ...fixture, move: async (from, to) => {
    if (!injected && to === target) { injected = true; throw failure; }
    await rename(from, to);
  } }), error => error === failure);
  assert.equal(injected, true); await assertOldPublication(fixture);
});

test('coverage publication keeps every old report when a later report cannot be copied', async () => {
  await mkdir(resolve('.tmp/tests'), { recursive: true });
  const root = await mkdtemp(resolve('.tmp/tests', 'coverage-publication-'));
  try {
    const packages = await Promise.all(['a', 'b'].map(async name => {
      const packageRoot = resolve(root, name); await mkdir(resolve(packageRoot, 'coverage'), { recursive: true });
      await writeFile(resolve(packageRoot, 'coverage/old.txt'), name);
      return { name, packageRoot, verification: { coverageWorkers: 1 }, manifest: { scripts: { 'test:coverage': 'vitest run --coverage' } } };
    }));
    const context = { root, budget: createTestWorkerBudget({ limit: 2 }), execute: async spec => {
      await mkdir(spec.logRoot, { recursive: true });
      await writeFile(resolve(spec.logRoot, 'results.json'), JSON.stringify({ success: true, numFailedTests: 0, numPassedTests: 1, numPendingTests: 0, testResults: [] }));
      if (spec.name === 'a') { await mkdir(resolve(spec.logRoot, 'coverage')); await writeFile(resolve(spec.logRoot, 'coverage/new.txt'), spec.name); }
    } };
    await writeFile(resolve(root, 'coverage-summary.json'), 'old summary');
    await assert.rejects(runWorkspaceCoverage({ packages, context }), { code: 'ENOENT' });
    for (const value of packages) assert.equal(await readFile(resolve(value.packageRoot, 'coverage/old.txt'), 'utf8'), value.name);
    assert.equal(await readFile(resolve(root, 'coverage-summary.json'), 'utf8'), 'old summary');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('coverage scheduling discovers test files and starts larger suites first', async () => {
  await mkdir(resolve('.tmp/tests'), { recursive: true });
  const root = await mkdtemp(resolve('.tmp/tests', 'coverage-order-'));
  try {
    const packages = await Promise.all(['small', 'large', 'none'].map(async (name) => {
      const packageRoot = resolve(root, name);
      await mkdir(resolve(packageRoot, 'tests'), { recursive: true });
      await writeFile(resolve(packageRoot, 'package.verify.json'), '{"browserExports":[]}');
      return { name, packageRoot, exports: [], bins: [], manifest: { scripts: { 'test:coverage': 'vitest run --coverage' } } };
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

test('ordinary coverage packages share two workers without adding another package pool', async () => {
  await mkdir(resolve('.tmp/tests'), { recursive: true });
  const root = await mkdtemp(resolve('.tmp/tests', 'coverage-concurrency-'));
  try {
    const packages = await Promise.all(['one', 'two', 'three'].map(async (name) => {
      const packageRoot = resolve(root, name);
      await mkdir(packageRoot, { recursive: true });
      await writeFile(resolve(packageRoot, 'package.verify.json'), '{"browserExports":[]}');
      return { name, packageRoot, exports: [], bins: [],
        manifest: { scripts: { 'test:coverage': 'vitest run --coverage' } } };
    }));
    let active = 0;
    let maximum = 0;
    await runWorkspaceCoverage({ packages, concurrency: 2, run: async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await delay(20);
      active -= 1;
    } });
    assert.equal(maximum, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a two-worker package excludes other packages and is reduced to one in serial mode', async () => {
  await mkdir(resolve('.tmp/tests'), { recursive: true });
  const root = await mkdtemp(resolve('.tmp/tests', 'coverage-weight-'));
  try {
    const packages = await Promise.all([['heavy', 2], ['small', 1], ['later', 1]].map(async ([name, coverageWorkers]) => {
      const packageRoot = resolve(root, name); await mkdir(packageRoot);
      await writeFile(resolve(packageRoot, 'package.verify.json'), JSON.stringify({ browserExports: [], coverageWorkers }));
      return { name, packageRoot, exports: [], bins: [], manifest: { scripts: { 'test:coverage': 'vitest run --coverage' } } };
    }));
    for (const concurrency of [1, 2]) {
      let active = 0, peak = 0; const allocations = [];
      await runWorkspaceCoverage({ packages, concurrency, run: async ({ name }, lease) => {
        allocations.push([name, lease.workers]); active += lease.workers; peak = Math.max(peak, active);
        await delay(10); active -= lease.workers;
      } });
      assert.equal(peak, concurrency); assert.deepEqual(allocations.find(([name]) => name === 'heavy'), ['heavy', concurrency]);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
