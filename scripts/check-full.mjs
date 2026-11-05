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
  createContext = createTestRunContext, scriptTests = runScriptTestSuite, coverage = runWorkspaceCoverage, signal, label = 'check:full' } = {}) => {
  const started = performance.now();
  let testRun, workspace;
  const failures = [], background = [], cancellation = new globalThis.AbortController();
  const lateLint = testWorkerLimit() >= 4;
  const overlapConsumers = testWorkerLimit() === 8 && coverage !== false;
  const activeSignal = signal ? globalThis.AbortSignal.any([signal, cancellation.signal]) : cancellation.signal;
  let stopping, pipelined = false, consumerReady = false, scriptCompletion = Promise.resolve();
  const fail = error => {
    // 内部取消的派生拒绝已由首错记录；undefined首错也不能被默认AbortError替换。
    if (cancellation.signal.aborted && error === cancellation.signal.reason) return;
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
  const onBeforeCleanup = async (error, hasFailure = error !== undefined) => {
    // 主体首败先触发取消，避免清理门闩等到整套覆盖率自然结束。
    if (hasFailure) fail(error);
    else if (activeSignal.aborted && failures.length === 0) fail(activeSignal.reason);
    await Promise.allSettled(background);
    await stopping;
  };
  const timed = (name, task) => {
    const start = performance.now();
    let result;
    try { activeSignal.throwIfAborted(); result = task(); }
    catch (error) { result = Promise.reject(error); }
    return Promise.resolve(result).then(value => { activeSignal.throwIfAborted(); return value; }).finally(() => {
      process.stdout.write(`${label} ${name}: ${((performance.now() - start) / 1_000).toFixed(2)}s\n`);
    });
  };
  let built = false;
  const startBuiltChecks = () => {
    const scripts = pipelined ? timed('test:scripts', () => scriptTests(testRun)) : Promise.resolve();
    scriptCompletion = scripts;
    if (lateLint) start(async () => { await scripts; await timed('lint', () => run('lint', { signal: activeSignal })); });
    if (pipelined) {
      // build之后产物只读；先避开脚本与tsc的争用，再并行静态检查和coverage。
      start(async () => {
        await scripts;
        await timed('typecheck:built', () => run('typecheck:built', { signal: activeSignal }));
        await timed('packages:check-cycles:built', () => run('packages:check-cycles:built', { signal: activeSignal }));
      });
      if (coverage !== false && !overlapConsumers) start(async () => {
        await scripts;
        await timed('test:coverage', () => coverage({ packages: workspace.packages, context: testRun }));
      });
    }
  };
  const onBuilt = async model => {
    activeSignal.throwIfAborted();
    if (built) throw new Error('package build signaled more than once');
    built = true;
    workspace = model;
    testRun = await createContext({ packages: model.packages, signal });
    activeSignal.throwIfAborted();
    if (overlapConsumers && testRun.budget.limit !== 8) throw new Error('FULL_CHECK_WORKER_LIMIT');
    pipelined = testRun.budget.limit >= 4;
    if (!overlapConsumers) startBuiltChecks();
    return testRun;
  };
  const onConsumerReady = () => {
    activeSignal.throwIfAborted();
    if (!overlapConsumers) return;
    if (!built || !testRun) throw new Error('CONSUMER_READY_BEFORE_BUILD');
    if (consumerReady) throw new Error('CONSUMER_READY_DUPLICATE');
    consumerReady = true;
    // 原生脚本启动也会读取大量元数据；八槽模式先独占完成消费者安装。
    startBuiltChecks();
    // 安装和脚本完成后才让六槽覆盖率与一个消费者重叠，余量仍受同一根审计。
    start(async () => {
      await scriptCompletion;
      await timed('test:coverage', () => coverage({ packages: workspace.packages, context: testRun, workers: 6 }));
    });
  };
  try {
    if (!lateLint) await timed('lint', () => run('lint', { signal: activeSignal }));
    await timed('pack:check', () => verify({
      repositoryRoot,
      verificationRoot: resolve(repositoryRoot, '.tmp', 'package-verification'),
      tarballCacheRoot: resolve(repositoryRoot, '.tmp', 'check-cache', 'packs'),
      onBuilt, onConsumerReady, onBeforeCleanup, serialConsumerChecks: overlapConsumers, signal: activeSignal,
    }));
    if (!built) throw new Error('package build did not complete');
    if (overlapConsumers && !consumerReady) throw new Error('CONSUMER_READY_REQUIRED');
    if (!pipelined) {
      await timed('typecheck:built', () => run('typecheck:built', { signal: activeSignal }));
      await timed('packages:check-cycles:built', () => run('packages:check-cycles:built', { signal: activeSignal }));
      await timed('test:scripts', () => scriptTests(testRun));
      if (coverage !== false) await timed('test:coverage', () => coverage({ packages: workspace.packages, context: testRun }));
    }
  } catch (error) {
    fail(error);
  } finally {
    // 后台失败已有接收方；先等待所有已开始阶段和取消收尾，再关闭共享context。
    await onBeforeCleanup();
    try { await testRun?.finalize(); }
    catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'full check failed and context cleanup failed', { cause: failures[0] });
  signal?.throwIfAborted();
  process.stdout.write(`${label} complete: ${((performance.now() - started) / 1_000).toFixed(2)}s\n`);
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
