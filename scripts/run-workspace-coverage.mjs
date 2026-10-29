import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { createPackageManagerInvocation } from './package-manager-command.mjs';
import { discoverWorkspacePackageModel } from './workspace-packages.mjs';
import { loadPackageVerification } from './package-verification.mjs';
import { createTestWorkerBudget, testWorkerLimit } from './test-worker-budget.mjs';
import { createTestRunContext } from './test-run-context.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const scriptPath = fileURLToPath(import.meta.url);
const ignoredDirectories = new Set(['.git', '.tmp', 'coverage', 'dist', 'node_modules']);
const testFilename = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

export const publishCoverageReports = async ({ reports, root, summary, copy = cp, write = writeFile, move = rename, remove = rm }) => {
  const owned = (parent, path) => { const value = relative(parent, path); return value && !value.startsWith('..') && !isAbsolute(value); };
  if (!owned(resolve(repositoryRoot, '.tmp'), resolve(root))) throw new Error('unsafe coverage publication root');
  const outputs = reports.map(report => {
    const target = resolve(report.packageRoot, 'coverage');
    const source = resolve(report.logRoot, 'coverage');
    if (!owned(repositoryRoot, target) || relative(report.packageRoot, target) !== 'coverage'
      || !owned(resolve(root), source)) throw new Error('unsafe coverage output');
    return { target, source };
  });
  if (new Set(outputs.map(value => value.target)).size !== outputs.length) throw new Error('duplicate coverage output');
  const staging = await mkdtemp(resolve(root, 'coverage-publish-'));
  let retainRecovery = false;
  const failures = [];
  try {
    await mkdir(resolve(staging, 'new')); await mkdir(resolve(staging, 'old'));
    const changes = outputs.map((value, index) => ({ ...value, staged: resolve(staging, 'new', String(index)), backup: resolve(staging, 'old', String(index)) }));
    // 全部复制与汇总完成后再替换；只有回滚失败才保留本次恢复备份。
    for (const change of changes) await copy(change.source, change.staged, { recursive: true });
    const stagedSummary = resolve(staging, 'summary.json');
    await write(stagedSummary, `${JSON.stringify(summary, null, 2)}\n`);
    changes.push({ target: resolve(root, 'coverage-summary.json'), staged: stagedSummary, backup: resolve(staging, 'old-summary.json') });
    const attempted = [];
    try {
      for (const change of changes) {
        const state = { ...change, previous: false, published: false }; attempted.push(state);
        try { await move(state.target, state.backup); state.previous = true; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        await move(state.staged, state.target); state.published = true;
      }
    } catch (failure) {
      const rollbackFailures = [];
      for (const state of attempted.reverse()) {
        try {
          if (state.published) await rm(state.target, { recursive: true, force: true });
          if (state.previous) await move(state.backup, state.target);
        } catch (error) { rollbackFailures.push(error); }
      }
      if (rollbackFailures.length) {
        retainRecovery = true;
        throw new AggregateError([failure, ...rollbackFailures], `coverage rollback failed; prior reports retained under ${staging}`, { cause: failure });
      }
      throw failure;
    }
  } catch (error) { failures.push(error); }
  if (!retainRecovery) {
    try { await remove(staging, { recursive: true, force: true }); }
    catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures,
    `coverage publication and temporary cleanup failed; inspect ${staging}`, { cause: failures[0] });
};

const countTests = async (directory) => {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) {
      count += await countTests(resolve(directory, entry.name));
    } else if (entry.isFile() && testFilename.test(entry.name)) {
      count += 1;
    }
  }
  return count;
};
export const discoverPackageTestFiles = async (root, directory = root) => {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) files.push(...await discoverPackageTestFiles(root, path));
    else if (entry.isFile() && testFilename.test(entry.name)) files.push(relative(root, path).replaceAll('\\', '/'));
  }
  return files.sort();
};

export const orderCoveragePackages = async (packages) => {
  const candidates = packages.filter(({ manifest }) => manifest.scripts?.['test:coverage']);
  const rows = await Promise.all(candidates.map(async (packageValue) => ({
    packageValue,
    tests: await countTests(packageValue.packageRoot),
  })));
  rows.sort((left, right) => right.tests - left.tests
    || left.packageValue.name.localeCompare(right.packageValue.name));
  return rows.map(({ packageValue }) => packageValue);
};

export const runWorkspaceCoverage = async ({
  packages,
  concurrency = testWorkerLimit(), context, run, quick = false,
} = {}) => {
  const discovered = packages ?? (await discoverWorkspacePackageModel({ repositoryRoot })).packages;
  const ordered = await orderCoveragePackages(discovered);
  const own = !context && !run;
  context ??= run ? undefined : await createTestRunContext({ packages: discovered, workers: concurrency });
  const budget = context?.budget ?? createTestWorkerBudget({ limit: concurrency });
  const plans = await Promise.all(ordered.map(async value => {
    const verification = value.verification ?? await loadPackageVerification(value);
    return { value, workers: Math.min(verification.coverageWorkers, budget.limit) };
  }));
  plans.sort((a, b) => b.workers - a.workers);
  const started = performance.now();
  try {
    const results = await Promise.allSettled(plans.map(({ value, workers }, index) => budget.run({ name: value.name, workers }, async lease => {
      if (run) return run(value, lease);
      const script = quick ? 'test' : 'test:coverage';
      if (quick && (!value.quickTests?.length || value.manifest.scripts.test !== 'vitest run')) throw new Error('QUICK_TEST_MANIFEST_INVALID');
      if (/--(?:maxWorkers|pool|config|coverage\.reportsDirectory|outputFile)/u.test(value.manifest.scripts[script])) throw new Error(`${value.name} coverage command requires budget-controlled configuration`);
      const logRoot = resolve(context.root, 'coverage-jobs', String(index));
      const invocation = createPackageManagerInvocation('pnpm', ['--filter', value.name, 'run', script, '--config', resolve(repositoryRoot, 'scripts/vitest-budget-config.mjs'), ...(quick ? value.quickTests : [])]);
      await context.execute({ name: value.name, ...invocation, cwd: repositoryRoot, logRoot,
        env: { ...process.env, FORGE_CHECK_PACKAGE_ROOT: value.packageRoot } }, lease);
      const report = JSON.parse(await readFile(resolve(logRoot, 'results.json'), 'utf8'));
      if (!report.success || report.numFailedTests) throw new Error(`${value.name} has incomplete coverage test results`);
      return { name: value.name, workers, logRoot, files: report.testResults.map(row => row.name), passed: report.numPassedTests, skipped: report.numPendingTests };
    })));
    const failures = results.filter(value => value.status === 'rejected').map(value => value.reason);
    if (failures.length) throw new AggregateError([...new Set(failures)], 'workspace coverage failed after running tasks drained');
    if (!run && !quick) {
      await publishCoverageReports({ root: context.root, summary: results.map(value => value.value),
        reports: plans.map((plan, index) => ({ packageRoot: plan.value.packageRoot, logRoot: results[index].value.logRoot })) });
    }
    process.stdout.write(`Workspace ${quick ? 'quick tests' : 'coverage'} passed for ${String(ordered.length)} packages in ${((performance.now() - started) / 1_000).toFixed(2)}s.\n`);
  } finally { if (own) await context.finalize(); }
};
export const runWorkspaceQuickTests = options => runWorkspaceCoverage({ ...options, quick: true });

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try { await runWorkspaceCoverage(); }
  catch (error) { process.stderr.write(`${error?.stack ?? error}\n`); process.exitCode = 1; }
}
