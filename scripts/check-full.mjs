import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { createPackageManagerInvocation } from './package-manager-command.mjs';
import { verifyLocalPackages } from './package-consumer-runner.mjs';
import { createTestRunContext } from './test-run-context.mjs';
import { runScriptTestSuite } from './run-script-tests.mjs';
import { runWorkspaceCoverage } from './run-workspace-coverage.mjs';
import { testWorkerLimit } from './test-worker-budget.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const scriptPath = fileURLToPath(import.meta.url);

const runPnpmScript = (name) => new Promise((resolvePromise, reject) => {
  const invocation = createPackageManagerInvocation('pnpm', ['run', name]);
  const child = spawn(invocation.command, invocation.args, {
    cwd: repositoryRoot, stdio: 'inherit', shell: false, windowsHide: true,
  });
  child.once('error', reject);
  child.once('exit', (code) => code === 0
    ? resolvePromise()
    : reject(new Error(`${name} exited with ${String(code)}`)));
});

export const runFullCheck = async ({ run = runPnpmScript, verify = verifyLocalPackages,
  createContext = createTestRunContext, scriptTests = runScriptTestSuite, coverage = runWorkspaceCoverage } = {}) => {
  const started = performance.now();
  let testRun, workspace;
  const failures = [];
  const timed = (name, task) => {
    const start = performance.now();
    let result;
    try { result = task(); }
    catch (error) { result = Promise.reject(error); }
    return Promise.resolve(result).finally(() => {
      process.stdout.write(`check:full ${name}: ${((performance.now() - start) / 1_000).toFixed(2)}s\n`);
    });
  };
  let built = false;
  const onBuilt = async model => {
    if (built) throw new Error('package build signaled more than once');
    built = true;
    workspace = model;
    testRun = await createContext({ packages: model.packages });
    return testRun;
  };
  try {
    await timed('lint', () => run('lint'));
    await timed('pack:check', () => verify({
      repositoryRoot,
      verificationRoot: resolve(repositoryRoot, '.tmp', 'package-verification'),
      tarballCacheRoot: resolve(repositoryRoot, '.tmp', 'check-cache', 'packs'),
      onBuilt,
    }));
    if (!built) throw new Error('package build did not complete');
    await timed('typecheck:built', () => run('typecheck:built'));
    await timed('packages:check-cycles:built', () => run('packages:check-cycles:built'));
    await timed('test:scripts', () => scriptTests(testRun));
    await timed('test:coverage', () => coverage({ packages: workspace.packages, context: testRun }));
  } catch (error) {
    failures.push(error);
    try { testRun?.budget.stop(error); }
    catch (stopError) { failures.push(stopError); }
  } finally {
    try { await testRun?.finalize(); }
    catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'full check failed and context cleanup failed', { cause: failures[0] });
  process.stdout.write(`check:full complete: ${((performance.now() - started) / 1_000).toFixed(2)}s\n`);
};

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    if (process.argv.slice(2).some(value => value !== '--serial')) throw new Error('unsupported full check option');
    if (process.argv.includes('--serial')) process.env.FORGE_CHECK_TEST_WORKERS = '1';
    testWorkerLimit(); await runFullCheck();
  }
  catch (error) { process.stderr.write(`${error?.stack ?? error}\n`); process.exitCode = 1; }
}
