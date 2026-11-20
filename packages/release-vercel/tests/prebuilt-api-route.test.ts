import { afterEach, expect, it, vi } from 'vitest';
import { ca, origin, proxy } from '../../http-transport/tests/loopback.js';
import { prebuiltApiOnce } from '../src/node/prebuilt-http.js';
import { prebuiltConfiguration } from './helpers/prebuilt-configuration.js';

const endpoint = vi.hoisted(() => ({ url: '' }));
vi.mock('node:https', async original => ({ ...await original<typeof import('node:https')>(), request: () => {
  throw new Error('explicit route unexpectedly entered the default request');
} }));
// 仅重定向固定 API 地址，代理、TLS、请求及关闭仍为真实网络操作。
vi.mock('@openge/forge-http-transport/node', async original => {
  const transport = await original<typeof import('@openge/forge-http-transport/node')>();
  return { ...transport, createNodeHttpTransport: (options: Parameters<typeof transport.createNodeHttpTransport>[0]) => {
    const client = transport.createNodeHttpTransport(options);
    return { ...client, fetch: (url: URL, request: RequestInit) => {
      if (url.origin !== 'https://api.vercel.com' || !endpoint.url) throw new Error('fixture API endpoint required');
      return client.fetch(new URL(`${url.pathname}${url.search}`, endpoint.url), request);
    } };
  } };
});

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); vi.unstubAllEnvs(); endpoint.url = ''; });

it('routes one GET and one POST through CONNECT and keeps explicit direct independent', async () => {
  vi.stubEnv('VERCEL_TOKEN', 'fixture-token');
  const calls: { method: string | undefined; body: string; token: string | undefined }[] = [];
  const server = await origin((request, response) => {
    let body = ''; request.setEncoding('utf8'); request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => { calls.push({ method: request.method, body, token: request.headers.authorization }); response.end('{}'); });
  }, true);
  closers.push(server.close); endpoint.url = server.url;
  const gateway = await proxy(server.port); closers.push(gateway.close);
  const proxyOptions = { route: 'proxy', environment: { HTTPS_PROXY: gateway.url }, tls: { ca } } as const;
  const directOptions = { route: 'direct', environment: { HTTPS_PROXY: gateway.url }, tls: { ca } } as const;
  const config = { ...prebuiltConfiguration(), limits: { ...prebuiltConfiguration().limits, requestMs: 2000 } };
  const signal = new AbortController().signal;
  await expect(prebuiltApiOnce(config, '/fixture', 'GET', '', signal, false, 2000, proxyOptions)).resolves.toMatchObject({ status: 200 });
  await expect(prebuiltApiOnce(config, '/fixture', 'POST', '{"value":1}', signal, false, 2000, proxyOptions)).resolves.toMatchObject({ status: 200 });
  await expect(prebuiltApiOnce(config, '/fixture', 'GET', '', signal, false, 2000, directOptions)).resolves.toMatchObject({ status: 200 });
  expect(gateway.requests).toHaveLength(2);
  expect(calls).toEqual([
    { method: 'GET', body: '', token: 'Bearer fixture-token' },
    { method: 'POST', body: '{"value":1}', token: 'Bearer fixture-token' },
    { method: 'GET', body: '', token: 'Bearer fixture-token' },
  ]);
  await vi.waitFor(() => { expect(gateway.sockets.size).toBe(0); expect(server.sockets.size).toBe(0); });
});

it('drains the tunnel on cancellation after a POST is received and never resends it', async () => {
  vi.stubEnv('VERCEL_TOKEN', 'fixture-token');
  const controller = new AbortController();
  let receive!: () => void;
  const received = new Promise<void>(resolve => { receive = resolve; });
  let posts = 0;
  const server = await origin(request => {
    request.resume(); request.once('end', () => { posts++; receive(); });
  }, true);
  closers.push(server.close); endpoint.url = server.url;
  const gateway = await proxy(server.port); closers.push(gateway.close);
  const base = prebuiltConfiguration(), config = { ...base, limits: { ...base.limits, requestMs: 2000 } };
  const result = expect(prebuiltApiOnce(config, '/fixture', 'POST', '{}', controller.signal, false, 2000,
    { route: 'proxy', proxyUrl: gateway.url, tls: { ca } })).rejects.toMatchObject({ code: 'CANCELLED' });
  await Promise.race([received, result]);
  controller.abort(); await result;
  expect(posts).toBe(1); expect(gateway.requests).toHaveLength(1);
  await vi.waitFor(() => { expect(gateway.sockets.size).toBe(0); expect(server.sockets.size).toBe(0); });
});

it('bounds routed response bytes and closes the connection after rejecting them', async () => {
  vi.stubEnv('VERCEL_TOKEN', 'fixture-token');
  const server = await origin((_request, response) => response.end('x'.repeat(1024)), true);
  closers.push(server.close); endpoint.url = server.url;
  const base = prebuiltConfiguration(), config = { ...base, limits: { ...base.limits, requestMs: 2000, maxOutputBytes: 32 } };
  await expect(prebuiltApiOnce(config, '/fixture', 'GET', '', new AbortController().signal, false, 2000,
    { route: 'direct', tls: { ca } })).rejects.toMatchObject({ code: 'VERCEL_API', details: { reason: 'OUTPUT_LIMIT' } });
  await vi.waitFor(() => expect(server.sockets.size).toBe(0));
});
