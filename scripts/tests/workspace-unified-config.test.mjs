import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import test from 'node:test';
import { discoverWorkspacePackageModel } from '../workspace-packages.mjs';
import { discoverTestProcessSupervisor, runTestProcess } from '../test-process-runner.mjs';

const module = await import('../vitest-unified-budget-config.mjs').catch(error => ({ error }));
const repositoryRoot = resolve(import.meta.dirname, '../..');
const create = async options => { assert.ifError(module.error); return module.createUnifiedVitestBudgetConfig(options); };
const root = resolve('.tmp/unified-config');
const packages = ['one', 'two'].map(name => ({ name, packageRoot: resolve(root, name), verification: { coverageWorkers: 8 } }));
const options = { packages, repositoryRoot: root, jobRoot: resolve(root, 'job'), workers: 8, env: {},
  load: async ({ packageRoot, workers }) => ({ root: packageRoot, test: { maxWorkers: workers, fileParallelism: workers > 1,
    testTimeout: packageRoot.endsWith('one') ? 50 : 500, coverage: { provider: 'v8' } } }) };

test('one workspace project shares transforms and retains every package root and timeout', async () => {
  const value = await create(options);
  assert.equal(value.test.projects, undefined); assert.equal(value.test.maxWorkers, 8);
  assert.equal(value.test.provide.forgePackageSettings.length, 2);
  assert.deepEqual(value.test.provide.forgePackageSettings.map(row => row.testTimeout), [50, 500]);
  assert.equal(value.test.include.length, 2); assert.equal(value.test.coverage.include.length, 2);
  assert.equal(value.test.isolate, true); assert.equal(value.test.bail, 1);
});

test('unified execution refuses a lower package limit or configuration it cannot preserve', async () => {
  await assert.rejects(create({ ...options, packages: [{ ...packages[0], verification: { coverageWorkers: 1 } }] }), /WORKSPACE_UNIFIED_CONFIG_UNSUPPORTED/u);
  for (const extra of [{ setupFiles: ['setup.ts'] }, { environment: 'jsdom' }, { coverage: { provider: 'v8', thresholds: { lines: 100 } } }]) {
    await assert.rejects(create({ ...options, load: async ({ packageRoot }) => ({ root: packageRoot,
      test: { coverage: { provider: 'v8' }, ...extra } }) }), /WORKSPACE_UNIFIED_CONFIG_UNSUPPORTED/u);
  }
});

test('real unified workers retain package cwd and different test timeouts', { timeout: 45_000 }, async t => {
  assert.ifError(module.error);
  const parent = resolve(repositoryRoot, '.tmp/tests'); await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(resolve(parent, 'unified-budget-'));
  t.after(async () => {
    const inside = relative(parent, temporary); assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside));
    await rm(temporary, { recursive: true, force: true });
  });
  const configPackages = [];
  for (const [name, testTimeout] of [['fast', 50], ['slow', 2_000]]) {
    const packageRoot = resolve(temporary, name); await mkdir(resolve(packageRoot, 'tests'), { recursive: true });
    configPackages.push({ name, packageRoot, verification: { coverageWorkers: 1 }, testTimeout });
    await writeFile(resolve(packageRoot, 'tests/cwd.test.mjs'), `import {it,expect} from 'vitest';it('${name}',async()=>{expect(process.cwd()).toBe(${JSON.stringify(repositoryRoot)});await new Promise(resolve=>setTimeout(resolve,150));});\n`);
  }
  const jobRoot = resolve(temporary, 'job'), config = resolve(temporary, 'vitest.config.mjs');
  await writeFile(config, `import {createUnifiedVitestBudgetConfig} from ${JSON.stringify(pathToFileURL(resolve(repositoryRoot, 'scripts/vitest-unified-budget-config.mjs')).href)};
const packages=${JSON.stringify(configPackages)};
export default async()=>{const value=await createUnifiedVitestBudgetConfig({packages,repositoryRoot:${JSON.stringify(temporary)},jobRoot:${JSON.stringify(jobRoot)},workers:1,
load:async({packageRoot})=>({root:packageRoot,test:{testTimeout:packages.find(value=>value.packageRoot===packageRoot).testTimeout,coverage:{provider:'v8'}}})});value.test.bail=0;return value;};\n`);
  const supervisor = await discoverTestProcessSupervisor({ packages: (await discoverWorkspacePackageModel({ repositoryRoot })).packages });
  await assert.rejects(runTestProcess({ supervisor, name: 'unified timeout fixture', logRoot: jobRoot, cwd: repositoryRoot, signal: t.signal,
    command: process.execPath, args: [resolve(repositoryRoot, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config],
    env: { ...process.env, FORGE_CHECK_TEST_WORKERS: '1', VITEST_MAX_WORKERS: '1' } }), error => error.result.exitCode !== 0 && error.result.closure.empty);
  const result = JSON.parse(await readFile(resolve(jobRoot, 'results.json'), 'utf8'));
  assert.equal(result.numPassedTests, 1); assert.equal(result.numFailedTests, 1);
  const diagnostics = stripVTControlCharacters(await readFile(resolve(jobRoot, 'stderr.log'), 'utf8'));
  assert.match(diagnostics, /timed out in 50ms/u);
  assert.equal(result.testResults.find(row => row.name.includes('/slow/')).status, 'passed');
});
