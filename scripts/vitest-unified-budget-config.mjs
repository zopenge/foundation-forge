import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultInclude } from 'vitest/config';
import { createHiddenVitestPool } from './hidden-vitest-pool.mjs';
import { testWorkerLimit } from './test-worker-budget.mjs';
import { createVitestBudgetConfig } from './vitest-budget-config.mjs';
import { discoverWorkspacePackageModel } from './workspace-packages.mjs';
import { loadPackageVerification } from './package-verification.mjs';

const unsupported = () => new Error('WORKSPACE_UNIFIED_CONFIG_UNSUPPORTED');
const inside = (root, path) => { const child = relative(root, path); return child && !child.startsWith('..') && !isAbsolute(child); };
const allowedTest = new Set(['pool', 'maxWorkers', 'fileParallelism', 'bail', 'setupFiles', 'reporters', 'outputFile', 'coverage', 'testTimeout', 'hookTimeout', 'environment']);

/** 单项目复用转换图；只接受能逐项保持语义的包配置，不作隐式回退。 */
export async function createUnifiedVitestBudgetConfig({ packages, repositoryRoot, jobRoot, workers,
  configEnv, env = process.env, load = createVitestBudgetConfig }) {
  testWorkerLimit(workers);
  if (!packages.length || !jobRoot || packages.some(value => !inside(repositoryRoot, value.packageRoot))) throw unsupported();
  for (const [index, value] of packages.entries()) for (const other of packages.slice(index + 1)) {
    if (!relative(value.packageRoot, other.packageRoot) || inside(value.packageRoot, other.packageRoot) || inside(other.packageRoot, value.packageRoot)) throw unsupported();
  }
  if (env.VITEST_MAX_WORKERS !== undefined && (!Reflect.deleteProperty(env, 'VITEST_MAX_WORKERS') || env.VITEST_MAX_WORKERS !== undefined)) throw unsupported();
  const settings = [], include = [], coverageInclude = [];
  for (const [index, value] of packages.entries()) {
    if (Math.min(workers, value.verification?.coverageWorkers ?? workers) !== workers) throw unsupported();
    const base = await load({ packageRoot: value.packageRoot, jobRoot: resolve(jobRoot, 'packages', String(index)), workers, configEnv });
    const test = base.test ?? {}, coverage = test.coverage ?? {};
    if (Object.keys(base).some(key => !['root', 'cacheDir', 'test'].includes(key)) || relative(value.packageRoot, base.root ?? value.packageRoot)
      || Object.keys(test).some(key => !allowedTest.has(key)) || (test.setupFiles?.length ?? 0) !== 0
      || (test.environment ?? 'node') !== 'node' || coverage.provider !== 'v8'
      || Object.keys(coverage).some(key => !['provider', 'reporter', 'reportsDirectory'].includes(key))) throw unsupported();
    const row = { packageRoot: value.packageRoot };
    for (const key of ['testTimeout', 'hookTimeout']) if (test[key] !== undefined) {
      if (!Number.isFinite(test[key]) || test[key] < 0) throw unsupported();
      row[key] = test[key];
    }
    settings.push(row);
    const prefix = relative(repositoryRoot, value.packageRoot).replaceAll('\\', '/');
    include.push(...defaultInclude.map(pattern => `${prefix}/${pattern}`));
    coverageInclude.push(`${prefix}/src/**/*.ts`);
  }
  return { root: repositoryRoot, cacheDir: resolve(jobRoot, 'cache'), test: {
    pool: createHiddenVitestPool({ workers }), maxWorkers: workers, fileParallelism: workers > 1, isolate: true, bail: 1,
    include, setupFiles: [fileURLToPath(new URL('./vitest-package-setup.mjs', import.meta.url))], provide: { forgePackageSettings: settings },
    reporters: ['default', 'json'], outputFile: { json: resolve(jobRoot, 'results.json') },
    coverage: { provider: 'v8', reporter: ['json'], reportsDirectory: resolve(jobRoot, 'coverage'), include: coverageInclude },
  } };
}

export default async configEnv => {
  const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
  const roots = JSON.parse(process.env.FORGE_CHECK_PACKAGE_ROOTS ?? 'null');
  const model = await discoverWorkspacePackageModel({ repositoryRoot });
  if (!Array.isArray(roots) || !roots.length || new Set(roots).size !== roots.length
    || roots.some(root => !model.packages.some(value => value.packageRoot === root))) throw unsupported();
  const packages = roots.map(root => model.packages.find(value => value.packageRoot === root));
  for (const value of packages) value.verification = await loadPackageVerification(value);
  return createUnifiedVitestBudgetConfig({ packages, repositoryRoot, jobRoot: process.env.FORGE_CHECK_JOB_ROOT,
    workers: testWorkerLimit(), configEnv });
};
