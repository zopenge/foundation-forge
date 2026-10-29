import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { createPackageManagerInvocation } from './package-manager-command.mjs';
import { verifyLocalPackages } from './package-consumer-runner.mjs';
import { createTestRunContext } from './test-run-context.mjs';
import { runScriptTestSuite } from './run-script-tests.mjs';
import { runWorkspaceCoverageBatch as runWorkspaceCoverage } from './run-workspace-coverage-batch.mjs';
import { testWorkerLimit } from './test-worker-budget.mjs';
import { openCheckCancellation } from './check-cancellation.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const scriptPath = fileURLToPath(import.meta.url);

const runPnpmScript = (name, { signal } = {}) => new Promise((resolvePromise, reject) => {
  signal?.throwIfAborted();
  const invocation = createPackageManagerInvocation('pnpm', ['run', name]);
  const child = spawn(invocation.command, invocation.args, {
    cwd: repositoryRoot, stdio: 'inherit', shell: false, windowsHide: true,
  });
  child.once('error', reject);
  child.once('close', (code) => signal?.aborted ? reject(signal.reason) : code === 0
    ? resolvePromise()
    : reject(new Error(`${name} exited with ${String(code)}`)));
});

export const runFullCheck = async ({ run = runPnpmScript, verify = verifyLocalPackages,
  createContext = createTestRunContext, scriptTests = runScriptTestSuite, coverage = runWorkspaceCoverage, signal } = {}) => {
  const started = performance.now();
  let testRun, workspace;
  const failures = [], background = [], cancellation = new globalThis.AbortController();
  const lateLint = testWorkerLimit() >= 4;
  const activeSignal = signal ? globalThis.AbortSignal.any([signal, cancellation.signal]) : cancellation.signal;
  let stopping, pipelined = false;
  const fail = error => {
    if (!failures.includes(error)) failures.push(error);
    cancellation.abort(error);
    if (!stopping) {
      try { testRun?.budget.stop(error); } catch (cleanup) { if (!failures.includes(cleanup)) failures.push(cleanup); }
      stopping = Promise.resolve().then(() => testRun?.cancel?.(error)).catch(cleanup => {
        if (!failures.includes(cleanup)) failures.push(cleanup);
      });
    }
  };
  const start = task => { background.push(Promise.resolve().then(task).catch(fail)); };
  const timed = (name, task) => {
    const start = performance.now();
    let result;
    try { activeSignal.throwIfAborted(); result = task(); }
    catch (error) { result = Promise.reject(error); }
    return Promise.resolve(result).then(value => { activeSignal.throwIfAborted(); return value; }).finally(() => {
      process.stdout.write(`check:full ${name}: ${((performance.now() - start) / 1_000).toFixed(2)}s\n`);
    });
  };
  let built = false;
  const onBuilt = async model => {
    activeSignal.throwIfAborted();
    if (built) throw new Error('package build signaled more than once');
    built = true;
    workspace = model;
    testRun = await createContext({ packages: model.packages, signal });
    activeSignal.throwIfAborted();
    pipelined = testRun.budget.limit >= 4;
    const scripts = pipelined ? timed('test:scripts', () => scriptTests(testRun)) : Promise.resolve();
    if (lateLint) start(async () => { await scripts; await timed('lint', () => run('lint', { signal: activeSignal })); });
    if (pipelined) {
      // build之后产物只读；先避开脚本与tsc的争用，再并行静态检查和coverage。
      start(async () => {
        await scripts;
        await timed('typecheck:built', () => run('typecheck:built', { signal: activeSignal }));
        await timed('packages:check-cycles:built', () => run('packages:check-cycles:built', { signal: activeSignal }));
      });
      start(async () => {
        await scripts;
        await timed('test:coverage', () => coverage({ packages: workspace.packages, context: testRun }));
      });
    }
    return testRun;
  };
  try {
    if (!lateLint) await timed('lint', () => run('lint', { signal: activeSignal }));
    await timed('pack:check', () => verify({
      repositoryRoot,
      verificationRoot: resolve(repositoryRoot, '.tmp', 'package-verification'),
      tarballCacheRoot: resolve(repositoryRoot, '.tmp', 'check-cache', 'packs'),
      onBuilt, signal: activeSignal,
    }));
    if (!built) throw new Error('package build did not complete');
    if (!pipelined) {
      await timed('typecheck:built', () => run('typecheck:built', { signal: activeSignal }));
      await timed('packages:check-cycles:built', () => run('packages:check-cycles:built', { signal: activeSignal }));
      await timed('test:scripts', () => scriptTests(testRun));
      await timed('test:coverage', () => coverage({ packages: workspace.packages, context: testRun }));
    }
  } catch (error) {
    fail(error);
  } finally {
    // 后台失败已有接收方；先等待所有已开始阶段和取消收尾，再关闭共享context。
    await Promise.allSettled(background);
    await stopping;
    try { await testRun?.finalize(); }
    catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'full check failed and context cleanup failed', { cause: failures[0] });
  signal?.throwIfAborted();
  process.stdout.write(`check:full complete: ${((performance.now() - started) / 1_000).toFixed(2)}s\n`);
};

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  let cancellation;
  try {
    if (process.argv.slice(2).some(value => value !== '--serial')) throw new Error('unsupported full check option');
    if (process.argv.includes('--serial')) process.env.FORGE_CHECK_TEST_WORKERS = '1';
    cancellation = openCheckCancellation();
    process.stdout.write(`check cancellation file: ${cancellation.path}\n`);
    testWorkerLimit(); await runFullCheck({ signal: cancellation.signal });
  }
  catch (error) { process.stderr.write(`${error?.stack ?? error}\n`); process.exitCode = 1; }
  finally { cancellation?.close(); }
}
