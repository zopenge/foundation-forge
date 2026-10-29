import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHiddenVitestPool } from './hidden-vitest-pool.mjs';
import { testWorkerLimit, testWorkerTiers } from './test-worker-budget.mjs';
import { createVitestBudgetConfig } from './vitest-budget-config.mjs';
import { discoverWorkspacePackageModel } from './workspace-packages.mjs';
import { loadPackageVerification } from './package-verification.mjs';

/** 一次采集全部当前项目；共享同一OS槽位预算，不按包叠加worker池。 */
export async function createWorkspaceVitestBudgetConfig({ packages, repositoryRoot, jobRoot, workers,
  configEnv, env = process.env, load = createVitestBudgetConfig }) {
  testWorkerLimit(workers);
  if (!packages.length || !jobRoot) throw new Error('WORKSPACE_COVERAGE_INPUT_INVALID');
  // Vitest 4.1.9 最后用此全局变量覆盖每个项目；总预算继续由 FORGE 配置和共享池执行。
  if (env.VITEST_MAX_WORKERS !== undefined && (!Reflect.deleteProperty(env, 'VITEST_MAX_WORKERS') || env.VITEST_MAX_WORKERS !== undefined)) {
    throw new Error('WORKSPACE_COVERAGE_OVERRIDE_UNSAFE');
  }
  const pool = createHiddenVitestPool({ workers }), projects = [];
  for (const [index, value] of packages.entries()) {
    const projectWorkers = Math.min(workers, value.verification?.coverageWorkers ?? workers);
    const base = await load({ packageRoot: value.packageRoot, jobRoot: resolve(jobRoot, 'projects', String(index)), workers: projectWorkers, configEnv });
    const test = { ...base.test }, coverage = test.coverage ?? {};
    if (coverage.provider !== 'v8' || Object.keys(coverage).some(key => !['provider', 'reporter', 'reportsDirectory'].includes(key))) {
      throw new Error(`WORKSPACE_COVERAGE_CONFIG_UNSUPPORTED: ${value.name}`);
    }
    const groupOrder = test.sequence?.groupOrder ?? 0;
    if (!Number.isSafeInteger(groupOrder) || groupOrder < 0 || groupOrder > (Number.MAX_SAFE_INTEGER - 3) / testWorkerTiers.length)
      throw new Error(`WORKSPACE_COVERAGE_CONFIG_UNSUPPORTED: ${value.name}`);
    // Vitest要求同组使用同一上限；1槽项目仍保留原串行语义，其他档位各自成组。
    test.sequence = { ...test.sequence, groupOrder: groupOrder * testWorkerTiers.length + testWorkerTiers.indexOf(projectWorkers) };
    delete test.coverage; delete test.reporters; delete test.outputFile;
    projects.push({ ...base, root: value.packageRoot, test: { ...test, name: value.name, pool } });
  }
  return { root: repositoryRoot, cacheDir: resolve(jobRoot, 'cache'), test: {
    projects, pool, maxWorkers: workers, fileParallelism: workers > 1, bail: 1,
    reporters: ['default', 'json'], outputFile: { json: resolve(jobRoot, 'results.json') },
    coverage: { provider: 'v8', reporter: ['json'], reportsDirectory: resolve(jobRoot, 'coverage'),
      include: packages.map(value => `${relative(repositoryRoot, value.packageRoot).replaceAll('\\', '/')}/src/**/*.ts`) },
  } };
}

export default async configEnv => {
  const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
  const roots = JSON.parse(process.env.FORGE_CHECK_PACKAGE_ROOTS ?? 'null');
  const model = await discoverWorkspacePackageModel({ repositoryRoot });
  if (!Array.isArray(roots) || !roots.length || new Set(roots).size !== roots.length
    || roots.some(root => !model.packages.some(value => value.packageRoot === root))) throw new Error('WORKSPACE_COVERAGE_INPUT_INVALID');
  const packages = roots.map(root => model.packages.find(value => value.packageRoot === root));
  for (const value of packages) value.verification = await loadPackageVerification(value);
  return createWorkspaceVitestBudgetConfig({ packages, repositoryRoot, jobRoot: process.env.FORGE_CHECK_JOB_ROOT,
    workers: testWorkerLimit(), configEnv });
};
