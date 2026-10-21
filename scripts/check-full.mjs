import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { createPackageManagerInvocation } from './package-manager-command.mjs';
import { verifyLocalPackages } from './package-consumer-runner.mjs';

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

export const runFullCheck = async ({ run = runPnpmScript, verify = verifyLocalPackages } = {}) => {
  const started = performance.now();
  const timed = (name, task) => {
    const start = performance.now();
    let result;
    try { result = task(); }
    catch (error) { result = Promise.reject(error); }
    return Promise.resolve(result).finally(() => {
      process.stdout.write(`check:full ${name}: ${((performance.now() - start) / 1_000).toFixed(2)}s\n`);
    });
  };
  let builtChecks = Promise.resolve([]);
  let built = false;
  const onBuilt = () => {
    if (built) throw new Error('package build signaled more than once');
    built = true;
    builtChecks = Promise.allSettled([
      timed('typecheck:built', () => run('typecheck:built')),
      timed('packages:check-cycles:built', () => run('packages:check-cycles:built')),
    ]);
  };
  const initial = await Promise.allSettled([
    timed('lint', () => run('lint')),
    timed('test:scripts', () => run('test:scripts')),
    timed('pack:check', () => verify({
      repositoryRoot,
      verificationRoot: resolve(repositoryRoot, '.tmp', 'package-verification'),
      tarballCacheRoot: resolve(repositoryRoot, '.tmp', 'check-cache', 'packs'),
      onBuilt,
    })),
  ]);
  const final = await builtChecks;
  const failures = [...initial, ...final]
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, failures.map((error) => error?.message ?? String(error)).join('; '));
  }
  if (!built) throw new Error('package build did not complete');
  await timed('test:coverage', () => run('test:coverage'));
  process.stdout.write(`check:full complete: ${((performance.now() - started) / 1_000).toFixed(2)}s\n`);
};

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try { await runFullCheck(); }
  catch (error) { process.stderr.write(`${error?.stack ?? error}\n`); process.exitCode = 1; }
}
