import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { discoverWorkspacePackageModel } from './workspace-packages.mjs';
import { createTestRunContext } from './test-run-context.mjs';
import { publishCoverageReports } from './run-workspace-coverage.mjs';

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

export async function runWorkspaceCoverageBatch({ packages, context, signal } = {}) {
  const model = await discoverWorkspacePackageModel({ repositoryRoot });
  const selected = (packages ?? model.packages)
    .filter(value => value.manifest.scripts?.['test:coverage']);
  for (const value of selected) if (value.manifest.scripts['test:coverage'] !== 'vitest run --coverage') throw new Error(`WORKSPACE_COVERAGE_SCRIPT_UNSUPPORTED: ${value.name}`);
  const own = !context;
  context ??= await createTestRunContext({ packages: model.packages, signal });
  const started = performance.now();
  try {
    const logRoot = resolve(context.root, 'coverage-workspace');
    await context.run({ name: 'workspace coverage', workers: context.budget.limit, command: process.execPath,
      args: [resolve(repositoryRoot, 'node_modules/vitest/vitest.mjs'), 'run', '--coverage', '--config', resolve(repositoryRoot, 'scripts/vitest-unified-budget-config.mjs')],
      cwd: repositoryRoot, logRoot, env: { ...process.env, FORGE_CHECK_PACKAGE_ROOTS: JSON.stringify(selected.map(value => value.packageRoot)) } });
    const rows = partitionWorkspaceReports(selected,
      JSON.parse(await readFile(resolve(logRoot, 'coverage/coverage-final.json'), 'utf8')),
      JSON.parse(await readFile(resolve(logRoot, 'results.json'), 'utf8')));
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
      summary.push({ name: row.name, workers: context.budget.limit, logRoot: target, files: row.files, passed: row.passed, skipped: row.skipped });
    }
    context.signal?.throwIfAborted();
    await publishCoverageReports({ reports: outputs, root: context.root, summary });
    process.stdout.write(`Workspace coverage passed for ${selected.length} packages in ${((performance.now() - started) / 1000).toFixed(2)}s.\n`);
  } finally { if (own) await context.finalize(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runWorkspaceCoverageBatch(); }
  catch (error) { process.stderr.write(`${error?.stack ?? error}\n`); process.exitCode = 1; }
}
