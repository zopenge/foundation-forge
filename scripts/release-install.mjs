import { spawn, spawnSync } from 'node:child_process';
import { setTimeout, clearTimeout } from 'node:timers';

import { createPackageManagerInvocation } from './package-manager-command.mjs';
import { isTransientRegistryError, releaseError } from './release-propagation.mjs';
import { redactKnownTokens } from './release-redaction.mjs';

const readEvents = (output) => output.split(/\r?\n/u).flatMap((line) => {
  try { return [JSON.parse(line)]; } catch { return []; }
});

const networkCause = (event, message) => {
  const cause = event.cause ?? event.err?.cause;
  if (typeof cause?.code === 'string') return { code: cause.code };
  // pnpm 10 的 ndjson 会省略 Error.cause，仅在 err.message 保留底层 fetch 原因。
  if ((event.code ?? event.err?.code) !== 'ERR_PNPM_META_FETCH_FAIL') return undefined;
  const reason = message.match(/\breason: (.+)$/u)?.[1];
  if (reason === 'socket hang up') return { code: 'ECONNRESET' };
  const code = reason?.match(/\b(ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)\b/u)?.[1];
  return code === undefined ? undefined : { code };
};

export const createInstallFailure = (stdout, stderr, exitCode, lifecycleStarted = false) => {
  const events = readEvents(stdout);
  const event = events.findLast((value) => value.level === 'error') ?? {};
  const code = event.code ?? event.err?.code ?? 'CONSUMER_INSTALL_FAILED';
  const message = event.message || event.err?.message || stderr.trim() || '消费者安装失败';
  const status = Number(code.match(/^ERR_PNPM_FETCH_(\d+)$/u)?.[1]) || undefined;
  const url = event.request?.url ?? event.url ?? message.match(/GET\s+(https?:\/\/\S+?)(?=:\s|\s|$)/u)?.[1];
  let packageName = event.wantedDependency?.name ?? event.spec?.name ?? event.package?.name;
  if (!packageName && url) {
    try { packageName = decodeURIComponent(new URL(url).pathname.slice(1)).split('/-/')[0]; }
    catch { /* 无法识别目标的 404 不允许自动重试。 */ }
  }
  return releaseError(code, redactKnownTokens(message), {
    status, packageName, exitCode,
    cause: networkCause(event, message),
    lifecycleStarted: lifecycleStarted || events.some(({ name }) => name === 'pnpm:lifecycle'),
  });
};

export const isRetryableInstallError = (error, confirmedNames) => {
  if (error.lifecycleStarted) return false;
  if (error.code === 'ERR_PNPM_FETCH_404' || error.code === 'ERR_PNPM_NO_MATCHING_VERSION') {
    return confirmedNames.has(error.packageName);
  }
  return isTransientRegistryError(error);
};

export const runInstallCommand = ({ invocation, cwd, env, timeoutMilliseconds, spawnCommand = spawn }) => new Promise((resolve, reject) => {
  const child = spawnCommand(invocation.command, invocation.args, {
    cwd, env, shell: false, windowsHide: true,
    detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let lifecycleStarted = false;
  let partial = '';
  let terminationError;
  const timer = setTimeout(() => {
    timedOut = true;
    if (!child.pid) return;
    if (process.platform === 'win32') {
      const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true, shell: false, encoding: 'utf8', timeout: 5_000,
      });
      if (result.error) terminationError = result.error;
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') terminationError = error; }
    }
  }, timeoutMilliseconds);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout = (stdout + chunk).slice(-512 * 1_024);
    partial += chunk;
    const lines = partial.split('\n');
    partial = lines.pop().slice(-512 * 1_024);
    for (const event of readEvents(lines.join('\n'))) {
      if (event.name === 'pnpm:lifecycle') lifecycleStarted = true;
      if (event.level === 'warn') process.stderr.write(`${redactKnownTokens(event.message ?? event.code ?? 'pnpm warning')}\n`);
    }
  });
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-512 * 1_024); });
  child.once('error', (error) => { clearTimeout(timer); reject(error); });
  child.once('close', (code) => {
    clearTimeout(timer);
    if (timedOut) reject(releaseError('CONSUMER_INSTALL_TIMEOUT', '消费者安装超出剩余传播预算', {
      cause: terminationError, exitCode: code,
    }));
    else if (code !== 0) reject(createInstallFailure(stdout, stderr, code, lifecycleStarted));
    else resolve(stdout);
  });
});

export const installRegistryConsumer = async ({ cwd, env, budget, confirmedNames,
  run = runInstallCommand, onRetry = () => {},
}) => budget.retry(async (remaining) => run({
  invocation: createPackageManagerInvocation('pnpm', ['install', '--prefer-offline=false',
    '--frozen-lockfile=false', '--reporter=ndjson', '--fetch-retries=0',
    `--fetch-timeout=${String(Math.min(30_000, remaining))}`]),
  cwd, env, timeoutMilliseconds: remaining,
}), (error) => isRetryableInstallError(error, confirmedNames), onRetry);
