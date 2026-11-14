import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { discoverWorkspacePackageModel } from './workspace-packages.mjs';
import { createTestRunContext } from './test-run-context.mjs';
import { discoverPackageTestFiles, publishCoverageReports } from './run-workspace-coverage.mjs';
import { parseCoverageShard } from './ci-coverage-shards.mjs';
import { testWorkerLimit } from './test-worker-budget.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const within = (root, path) => { const child = relative(root, path); return child && child !== '..' && !child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(child); };

/** 按真实文件归属拆分原始Istanbul数据；不得丢弃未知来源或改变命中计数。 */
export function partitionWorkspaceReports(packages, coverage, result) {
  if (!result.success || result.numFailedTests) throw new Error('WORKSPACE_COVERAGE_INCOMPLETE');
  const rows = packages.map(value => ({ ...value, coverage: {}, files: [], passed: 0, skipped: 0 }));
  for (const [path, value] of Object.entries(coverage)) {
    const owner = rows.find(row => within(row.packageRoot, path));
    if (!owner) throw new Error(`WORKSPACE_COVERAGE_UNOWNED: ${path}`);
    owner.coverage[path] = value;
  }
  for (const file of result.testResults) {
    const owner = rows.find(row => within(row.packageRoot, file.name));
    if (!owner) throw new Error(`WORKSPACE_COVERAGE_UNOWNED: ${file.name}`);
    owner.files.push(file.name);
    for (const assertion of file.assertionResults) {
      if (assertion.status === 'failed') throw new Error('WORKSPACE_COVERAGE_INCOMPLETE');
      if (assertion.status === 'passed') owner.passed++; else owner.skipped++;
    }
  }
  if (rows.some(row => !row.files.length || !Object.keys(row.coverage).length)
    || rows.reduce((total, row) => total + row.passed, 0) !== result.numPassedTests) throw new Error('WORKSPACE_COVERAGE_INCOMPLETE');
  return rows;
}

async function coveragePackages(packages, needsModel, discover) {
  const model = !packages || needsModel ? await discover({ repositoryRoot }) : undefined;
  const selected = (packages ?? model.packages)
    .filter(value => value.manifest.scripts?.['test:coverage']);
  for (const value of selected) if (value.manifest.scripts['test:coverage'] !== 'vitest run --coverage') throw new Error(`WORKSPACE_COVERAGE_SCRIPT_UNSUPPORTED: ${value.name}`);
  return { model, selected };
}

const coverageArgs = () => [resolve(repositoryRoot, 'node_modules/vitest/vitest.mjs'), 'run', '--coverage',
  '--config', resolve(repositoryRoot, 'scripts/vitest-unified-budget-config.mjs')];

async function finishCoverageContext(context, own, failures) {
  if (own) try { await context.finalize(); } catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'workspace coverage and cleanup failed', { cause: failures[0] });
}

async function publishWorkspaceCoverage(selected, context, logRoot, result, workers = context.budget.limit) {
    const rows = partitionWorkspaceReports(selected,
      JSON.parse(await readFile(resolve(logRoot, 'coverage/coverage-final.json'), 'utf8')), result);
    const require = createRequire(import.meta.resolve('@vitest/coverage-v8/package.json'));
    const { createCoverageMap } = require('istanbul-lib-coverage'), { createContext } = require('istanbul-lib-report'), reports = require('istanbul-reports');
    const outputs = [], summary = [];
    for (const [index, row] of rows.entries()) {
      context.signal?.throwIfAborted();
      const target = resolve(context.root, 'coverage-jobs', String(index)), directory = resolve(target, 'coverage');
      await mkdir(directory, { recursive: true });
      const reportContext = createContext({ dir: directory, coverageMap: createCoverageMap(row.coverage) });
      for (const reporter of ['text', 'json', 'html']) reports.create(reporter).execute(reportContext);
      outputs.push({ packageRoot: row.packageRoot, logRoot: target });
      summary.push({ name: row.name, workers, logRoot: target, files: row.files, passed: row.passed, skipped: row.skipped });
    }
    context.signal?.throwIfAborted();
    await publishCoverageReports({ reports: outputs, root: context.root, summary });
}

export async function runWorkspaceCoverageBatch({ packages, context, signal, shard, workers = context?.budget.limit ?? testWorkerLimit(),
  discover = discoverWorkspacePackageModel } = {}) {
  workers = testWorkerLimit(workers);
  if (context && workers > context.budget.limit) throw new Error('WORKSPACE_COVERAGE_WORKERS');
  const selection = shard === undefined ? undefined : parseCoverageShard(shard);
  const { model, selected } = await coveragePackages(packages, !context, discover);
  const own = !context;
  context ??= await createTestRunContext({ packages: model.packages, signal });
  const started = performance.now();
  const failures = [];
  let partial;
  try {
    const logRoot = resolve(context.root, selection ? `coverage-shard-${selection.index}` : 'coverage-workspace');
    const args = coverageArgs(), blobPath = resolve(logRoot, 'blob.json');
    if (selection) args.push('--shard', shard, '--reporter=default', '--reporter=json', '--reporter=blob', `--outputFile.blob=${blobPath}`);
    await context.run({ name: 'workspace coverage', workers, command: process.execPath,
      args,
      cwd: repositoryRoot, logRoot, env: { ...process.env, FORGE_CHECK_COVERAGE_SHARD: selection ? '1' : undefined,
        FORGE_CHECK_COVERAGE_FULL_ORDER: !selection && ((context.budget.limit === 2 && workers === 2) || (context.budget.limit === 4 && workers === 4)
          || (context.budget.limit === 8 && workers === 6)) ? '1' : undefined,
        FORGE_CHECK_PACKAGE_ROOTS: JSON.stringify(selected.map(value => value.packageRoot)) } });
    const result = JSON.parse(await readFile(resolve(logRoot, 'results.json'), 'utf8'));
    if (!result.success || result.numFailedTests) throw new Error('WORKSPACE_COVERAGE_INCOMPLETE');
    if (selection) partial = { logRoot, blobPath, result };
    else {
      await publishWorkspaceCoverage(selected, context, logRoot, result, workers);
      process.stdout.write(`Workspace coverage passed for ${selected.length} packages in ${((performance.now() - started) / 1000).toFixed(2)}s.\n`);
    }
  } catch (error) { failures.push(error); }
  await finishCoverageContext(context, own, failures);
  return partial;
}

export async function mergeWorkspaceCoverage({ packages, context, blobsDirectory, expected, discover = discoverWorkspacePackageModel } = {}) {
  const { model, selected } = await coveragePackages(packages, !context, discover);
  const own = !context;
  context ??= await createTestRunContext({ packages: model.packages });
  let result;
  const failures = [];
  try {
    const logRoot = resolve(context.root, 'coverage-merge');
    await context.run({ name: 'workspace coverage merge', command: process.execPath, cwd: repositoryRoot,
      args: [...coverageArgs(), '--merge-reports', blobsDirectory], logRoot,
      env: { ...process.env, FORGE_CHECK_COVERAGE_SHARD: '1', FORGE_CHECK_PACKAGE_ROOTS: JSON.stringify(selected.map(value => value.packageRoot)) } });
    result = JSON.parse(await readFile(resolve(logRoot, 'results.json'), 'utf8'));
    const files = result.testResults.map(value => resolve(value.name)).sort();
    const allFiles = (await Promise.all(selected.map(async value => (await discoverPackageTestFiles(value.packageRoot))
      .map(file => resolve(value.packageRoot, file))))).flat().sort();
    if (new Set(files).size !== files.length || JSON.stringify(files) !== JSON.stringify(allFiles)
      || (expected && (result.numPassedTests !== expected.passed || result.numPendingTests !== expected.skipped))) {
      throw new Error('CI_SHARD_MERGED_FILES');
    }
    await publishWorkspaceCoverage(selected, context, logRoot, result);
  } catch (error) { failures.push(error); }
  await finishCoverageContext(context, own, failures);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runWorkspaceCoverageBatch(); }
  catch (error) { process.stderr.write(`${error?.stack ?? error}\n`); process.exitCode = 1; }
}
