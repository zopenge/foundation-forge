import { request as httpsRequest } from 'node:https';
import type { NodeHttpTransportOptions } from '@openge/forge-http-transport';
import { createNodeHttpTransport } from '@openge/forge-http-transport/node';
import type { ReleaseConfig } from '../contracts.js';
import { assertActive, ReleaseError } from './errors.js';

function responseError(status: number, method: 'GET' | 'POST', allowMissing: boolean): ReleaseError | undefined {
  if (status === 200 || (method === 'POST' && status === 202) || (allowMissing && status === 404)) return;
  return new ReleaseError(status === 401 || status === 403 ? 'AUTH_REQUIRED' : 'VERCEL_API', { status });
}

async function routedRequest(url: URL, options: NodeHttpTransportOptions, init: RequestInit, maxBytes: number): Promise<{ status: number; body: Buffer }> {
  // 独占一个 transport；destroy 等待本次请求及连接关闭后才交付结果。
  const client = createNodeHttpTransport(options);
  try {
    const response = await client.fetch(url, init), reader = response.body?.getReader();
    const chunks: Uint8Array[] = []; let length = 0;
    if (reader) try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > maxBytes) throw new ReleaseError('VERCEL_API', { reason: 'OUTPUT_LIMIT' });
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    return { status: response.status, body: Buffer.concat(chunks) };
  } finally { await client.close(); }
}

/** 仅访问固定Vercel API；一次请求、有限正文，等自有socket和request均关闭后交付。 */
export async function prebuiltApiOnce(config: ReleaseConfig, path: string, method: 'GET' | 'POST', body: string,
  signal: AbortSignal, allowMissing = false, timeoutMs = config.limits.requestMs, http?: NodeHttpTransportOptions): Promise<{ readonly status: number; readonly body: Buffer }> {
  assertActive(signal); const token = process.env.VERCEL_TOKEN;
  if (!token) throw new ReleaseError('AUTH_REQUIRED', { reason: 'PREBUILT_TOKEN_REQUIRED' });
  const requestMs = Math.min(config.limits.requestMs, timeoutMs, method === 'GET' ? 30_000 : Infinity);
  const maxBytes = Math.min(config.limits.maxOutputBytes, method === 'GET' ? 65_536 : Infinity);
  if (!Number.isFinite(requestMs) || requestMs <= 0) throw new ReleaseError('DEPLOYMENT_TIMEOUT');
  const url = new URL(path, 'https://api.vercel.com');
  if (!path.startsWith('/') || path.startsWith('//') || url.origin !== 'https://api.vercel.com' || url.hash)
    throw new ReleaseError('VERCEL_API', { reason: 'INVALID_API_PATH' });
  if (http) {
    const deadline = AbortSignal.timeout(requestMs);
    try {
      const result = await routedRequest(url, http, { method, signal: AbortSignal.any([signal, deadline]),
        redirect: 'manual', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(method === 'POST' ? { body } : {}) }, maxBytes);
      const failure = responseError(result.status, method, allowMissing);
      if (failure) throw failure;
      assertActive(signal);
      if (deadline.aborted) throw deadline.reason;
      return result;
    } catch (error) {
      assertActive(signal);
      if (deadline.aborted) throw new ReleaseError('VERCEL_API', { reason: 'REQUEST_TIMEOUT' });
      throw error instanceof ReleaseError ? error : new ReleaseError('VERCEL_API', { reason: 'REQUEST_UNCONFIRMED' });
    }
  }
  return new Promise((accept, reject) => {
    let failure: unknown, accepted = false, status = 0, requestClosed = false, socketClosed = true;
    const chunks: Buffer[] = [];
    const finish = () => {
      if (!requestClosed || !socketClosed) return;
      clearTimeout(timer);
      if (signal.aborted) reject(new ReleaseError('CANCELLED'));
      else if (failure || !accepted) reject(failure instanceof ReleaseError ? failure : new ReleaseError('VERCEL_API', { reason: 'REQUEST_UNCONFIRMED' }));
      else accept({ status, body: Buffer.concat(chunks) });
    };
    const request = httpsRequest(url, { method, agent: false, signal,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } }, response => {
      let length = 0;
      response.on('data', (bytes: Buffer) => {
        length += bytes.length;
        if (length > maxBytes) {
          const error = new ReleaseError('VERCEL_API', { reason: 'OUTPUT_LIMIT' });
          failure ??= error; request.destroy(error);
        }
        else chunks.push(bytes);
      });
      response.on('error', error => { failure ??= error; request.destroy(); });
      response.on('end', () => {
        status = response.statusCode ?? 0;
        const rejected = responseError(status, method, allowMissing);
        accepted = !rejected;
        failure ??= rejected;
      });
    });
    request.on('socket', socket => { socketClosed = false; socket.once('close', () => { socketClosed = true; finish(); }); });
    const timer = setTimeout(() => {
      const error = new ReleaseError('VERCEL_API', { reason: 'REQUEST_TIMEOUT' });
      failure ??= error; request.destroy(error);
    }, requestMs);
    request.on('error', error => { failure ??= error; });
    request.on('close', () => { requestClosed = true; finish(); });
    request.end(body);
  });
}
