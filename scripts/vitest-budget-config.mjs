import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { testWorkerLimit } from './test-worker-budget.mjs';
import { createHiddenVitestPool } from './hidden-vitest-pool.mjs';

const vitestRequire = createRequire(import.meta.resolve('vitest/package.json'));
const Vite = await import(pathToFileURL(vitestRequire.resolve('vite')).href);
const array = value => value === undefined ? [] : Array.isArray(value) ? value : [value];

export const createVitestBudgetConfig = async ({ packageRoot, jobRoot, workers, configEnv }) => {
  testWorkerLimit(workers);
  if (!packageRoot || !jobRoot) throw new Error('controlled Vitest requires package and job roots');
  const entries = await readdir(packageRoot);
  const candidates = ['vitest', 'vite'].map(prefix => entries.filter(name => new RegExp(`^${prefix}\\.config\\.[cm]?[jt]s$`, 'u').test(name)));
  const selected = candidates.find(values => values.length) ?? [];
  if (selected.length > 1) throw new Error('ambiguous package Vitest configuration');
  const loaded = selected.length ? await Vite.loadConfigFromFile(configEnv, resolve(packageRoot, selected[0]), packageRoot) : undefined;
  const base = loaded?.config ?? {}, test = base.test ?? {};
  if (typeof test.outputFile === 'string' || test.cache?.dir || test.projects) throw new Error('package test output or project configuration requires an explicit budget adapter');
  const reporters = array(test.reporters ?? 'default');
  return { ...base, root: base.root ?? packageRoot, cacheDir: resolve(jobRoot, 'cache'), test: {
    ...test, pool: createHiddenVitestPool({ workers }), maxWorkers: workers, fileParallelism: workers > 1, bail: 1,
    setupFiles: array(test.setupFiles),
    reporters: reporters.includes('json') ? reporters : [...reporters, 'json'],
    outputFile: { ...test.outputFile, json: resolve(jobRoot, 'results.json') },
    coverage: { ...test.coverage, reportsDirectory: resolve(jobRoot, 'coverage') },
  } };
};

export default configEnv => createVitestBudgetConfig({
  packageRoot: process.env.FORGE_CHECK_PACKAGE_ROOT,
  jobRoot: process.env.FORGE_CHECK_JOB_ROOT,
  workers: testWorkerLimit(), configEnv,
});
