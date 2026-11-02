import { request as httpsRequest } from 'node:https';
import type { ReleaseConfig } from '../contracts.js';
import { assertActive, ReleaseError } from './errors.js';

/** 仅访问固定Vercel API；一次请求、有限正文，等自有socket和request均关闭后交付。 */
export async function prebuiltApiOnce(config: ReleaseConfig, path: string, method: 'GET' | 'POST', body: string,
  signal: AbortSignal, allowMissing = false): Promise<{ readonly status: number; readonly body: Buffer }> {
  assertActive(signal); const token = process.env.VERCEL_TOKEN;
  if (!token) throw new ReleaseError('AUTH_REQUIRED', { reason: 'PREBUILT_TOKEN_REQUIRED' });
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
    const request = httpsRequest(new URL(path, 'https://api.vercel.com'), { method, agent: false, signal,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } }, response => {
      let length = 0;
      response.on('data', (bytes: Buffer) => {
        length += bytes.length;
        if (length > config.limits.maxOutputBytes) request.destroy(new ReleaseError('VERCEL_API', { reason: 'OUTPUT_LIMIT' }));
        else chunks.push(bytes);
      });
      response.on('error', error => { failure ??= error; request.destroy(); });
      response.on('end', () => {
        status = response.statusCode ?? 0;
        accepted = status === 200 || (method === 'POST' && status === 202) || (allowMissing && status === 404);
        if (!accepted) failure ??= new ReleaseError(status === 401 || status === 403 ? 'AUTH_REQUIRED' : 'VERCEL_API', { status });
      });
    });
    request.on('socket', socket => { socketClosed = false; socket.once('close', () => { socketClosed = true; finish(); }); });
    const timer = setTimeout(() => request.destroy(new ReleaseError('VERCEL_API', { reason: 'REQUEST_TIMEOUT' })), config.limits.requestMs);
    request.on('error', error => { failure ??= error; });
    request.on('close', () => { requestClosed = true; finish(); });
    request.end(body);
  });
}
