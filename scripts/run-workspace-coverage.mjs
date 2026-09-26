import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { createPackageManagerInvocation } from './package-manager-command.mjs';
import { runBounded } from './package-consumer-runner.mjs';
import { discoverWorkspacePackageModel } from './workspace-packages.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const scriptPath = fileURLToPath(import.meta.url);
const ignoredDirectories = new Set(['.git', '.tmp', 'coverage', 'dist', 'node_modules']);
const testFilename = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

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

const runPackage = (packageValue) => new Promise((resolvePromise, reject) => {
  const invocation = createPackageManagerInvocation('pnpm', [
    '--filter', packageValue.name, 'run', 'test:coverage',
  ]);
  const child = spawn(invocation.command, invocation.args, {
    cwd: repositoryRoot, stdio: 'inherit', shell: false, windowsHide: true,
  });
  child.once('error', reject);
  child.once('exit', (code) => code === 0
    ? resolvePromise()
    : reject(new Error(`${packageValue.name} test:coverage exited with ${String(code)}`)));
});

export const runWorkspaceCoverage = async ({
  packages,
  concurrency = Math.min(2, availableParallelism()),
  run = runPackage,
} = {}) => {
  const discovered = packages ?? (await discoverWorkspacePackageModel({ repositoryRoot })).packages;
  const ordered = await orderCoveragePackages(discovered);
  const started = performance.now();
  await runBounded(ordered, concurrency, async (packageValue) => {
    await run(packageValue);
  });
  process.stdout.write(`Workspace coverage passed for ${String(ordered.length)} packages in ${((performance.now() - started) / 1_000).toFixed(2)}s.\n`);
};

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try { await runWorkspaceCoverage(); }
  catch (error) { process.stderr.write(`${error?.stack ?? error}\n`); process.exitCode = 1; }
}
