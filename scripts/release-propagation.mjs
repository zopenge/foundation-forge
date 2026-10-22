import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { releasePolicyDefaults } from './release-policy.mjs';

export const releaseError = (code, message, details = {}) => Object.assign(new Error(message), {
  code, ...details,
});

const networkCodes = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

export const isTransientRegistryError = (error) => error?.code === 'REGISTRY_PENDING'
  || error?.status === 429 || (error?.status >= 500 && error?.status < 600)
  || networkCodes.has(error?.code) || networkCodes.has(error?.cause?.code)
  || error?.name === 'TimeoutError';

export const createPropagationBudget = ({
  timeoutMilliseconds = releasePolicyDefaults.pollTimeoutMilliseconds,
  intervalMilliseconds,
  now = () => performance.now(),
  sleep = delay,
} = {}) => {
  const deadline = now() + timeoutMilliseconds;
  const remaining = () => Math.max(0, Math.ceil(deadline - now()));
  const timeout = (cause) => releaseError('REGISTRY_PROPAGATION_TIMEOUT',
    '发布传播等待超时，已发布结果保留；请使用报告中的续验命令。', { cause });
  const retry = async (task, shouldRetry = isTransientRegistryError, onRetry = () => {}) => {
    let attempt = 0;
    let lastError;
    while (remaining() > 0) {
      try { return await task(remaining()); }
      catch (error) {
        if (!shouldRetry(error)) throw error;
        lastError = error;
      }
      const wait = intervalMilliseconds ?? [2_000, 4_000, 8_000, 15_000][Math.min(attempt, 3)];
      attempt += 1;
      if (remaining() <= wait) break;
      onRetry({ attempt, error: lastError, waitMilliseconds: wait });
      await sleep(wait);
    }
    throw timeout(lastError);
  };
  return { remaining, retry, timeout };
};

export const fetchRegistryResponse = async ({ fetch, url, budget, accept, allowMissing = true }) => {
  const remaining = budget.remaining();
  if (remaining <= 0) throw budget.timeout();
  const response = await fetch(url, {
    headers: accept === undefined ? {} : { accept },
    signal: globalThis.AbortSignal.timeout(Math.min(30_000, remaining)),
  });
  if (!response.ok) throw releaseError(
    response.status === 404 && allowMissing ? 'REGISTRY_PENDING' : 'REGISTRY_HTTP_ERROR',
    `registry 请求返回 ${String(response.status)}：${url}`, { status: response.status, url },
  );
  return response;
};
