import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { Dispatcher } from 'undici';
import type { HttpTransport, NodeHttpTransportOptions } from './contracts.js';
import { HttpTransportError, sanitizeHttpTransportError } from './errors.js';
import { createProxyConfiguration } from './proxy-configuration.js';
import { createResponse } from './response.js';
import { DispatcherPool, type DispatcherLease } from './dispatcher-pool.js';

export function createNodeHttpTransport(options: NodeHttpTransportOptions): HttpTransport {
  if (!options || !['direct', 'proxy'].includes(options.route)) throw new HttpTransportError('unknown');
  const timeout = options.connectTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new HttpTransportError('unknown');
  const ca = options.tls?.ca, proxyCa = options.tls?.proxyCa;
  const requestTls = { rejectUnauthorized: true, timeout, ...(ca !== undefined ? { ca: typeof ca === 'string' ? ca : [...ca] } : {}) };
  const proxyTls = { rejectUnauthorized: true, timeout, ...(proxyCa !== undefined ? { ca: typeof proxyCa === 'string' ? proxyCa : [...proxyCa] } : {}) };
  const configuration = options.route === 'proxy' ? createProxyConfiguration(options) : undefined;
  const pool = new DispatcherPool(requestTls, proxyTls);
  const lifetime = new AbortController();
  let closing: Promise<void> | undefined;
  const resolve = (input: string | URL) => {
    try {
      const url = new URL(input);
      if (!['http:', 'https:'].includes(url.protocol)) throw new HttpTransportError('unknown');
      const bypassed = configuration?.excludes(url) ?? false;
      const proxy = configuration && !bypassed ? url.protocol === 'https:' ? configuration.httpsProxy : configuration.httpProxy : undefined;
      if (configuration && !bypassed && !proxy) throw new HttpTransportError('proxy-connect');
      return { url, proxy, bypassed };
    } catch (error) { throw sanitizeHttpTransportError(error); }
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    let signal: AbortSignal | null | undefined, proxied = false;
    let lease: DispatcherLease | undefined;
    try {
      if (closing) throw new HttpTransportError('cancelled');
      const normalized = new Request(input, { ...init, redirect: 'manual' });
      signal = AbortSignal.any([normalized.signal, lifetime.signal]);
      const { url, proxy } = resolve(normalized.url);
      proxied = proxy !== undefined;
      lease = pool.acquire(proxy, signal);
      const headers = new Headers(normalized.headers);
      if (!headers.has('accept')) headers.set('accept', '*/*');
      if (!headers.has('accept-encoding')) headers.set('accept-encoding', 'identity');
      const data = await lease.dispatcher.request({ origin: url.origin, path: `${url.pathname}${url.search}`, method: normalized.method as Dispatcher.HttpMethod,
        // 原生桥接立即取得reader；连接建立前失败也能取消尚未读取的上传源。
        headers: [...headers].flat(), body: normalized.body ? Readable.fromWeb(normalized.body as NodeReadableStream<Uint8Array>, { signal }) : null,
        signal });
      return createResponse(data, normalized.url, normalized.method, signal, lease.release);
    } catch (error) {
      const failure = sanitizeHttpTransportError(error, signal);
      try { await lease?.retire(failure); } catch { throw new HttpTransportError('unknown'); }
      if (proxied && failure.classification.category === 'connection') throw new HttpTransportError('proxy-connect');
      throw failure;
    }
  };
  return { fetch, describeRoute: input => {
    const { proxy, bypassed } = resolve(input);
    return { route: proxy ? 'proxy' : 'direct', bypassed, ...(proxy ? { proxyOrigin: new URL(proxy).origin } : {}) };
  }, close: () => {
    lifetime.abort(new HttpTransportError('cancelled'));
    closing ??= pool.close().catch(error => { throw sanitizeHttpTransportError(error); });
    return closing;
  } };
}
