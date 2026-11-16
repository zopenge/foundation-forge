import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher } from 'undici';
import { HttpTransportError, classifyHttpTransportError } from '../src/index.js';
import type { HttpTransport, NodeHttpTransportOptions } from '../src/index.js';
import { createNodeHttpTransport } from '../src/node.js';
import { ca, origin, proxy } from './loopback.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()?.(); });
const own = <T extends { close(): Promise<void> }>(resource: T): T => { cleanup.push(() => resource.close()); return resource; };
const transport = (options: NodeHttpTransportOptions): HttpTransport => own(createNodeHttpTransport(options));
const failure = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return error; }
  throw new Error('EXPECTED_FAILURE');
};
const category = async (promise: Promise<unknown>) => classifyHttpTransportError(await failure(promise));
const bodyOf = (response: Response) => { if (!response.body) throw new Error('EXPECTED_BODY'); return response.body; };
const latch = () => {
  let resolve = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

describe('explicit HTTP routes', () => {
  it('cold-imports the built Node entry without initializing or replacing the host dispatcher', () => {
    const entry = new URL('../dist/node.js', import.meta.url).href;
    const code = `const key=Symbol.for('undici.globalDispatcher.1');const before=globalThis[key];
      const {createNodeHttpTransport}=await import(${JSON.stringify(entry)});
      const client=createNodeHttpTransport({route:'direct'});client.describeRoute('https://example.invalid');await client.close();
      if(globalThis[key]!==before)throw new Error('HOST_DISPATCHER_CHANGED');`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8', shell: false, windowsHide: true, timeout: 5000,
    });
    expect(child.status, child.stderr).toBe(0);
  });

  it('describes the exact route without credentials and fails closed on missing protocol proxy', () => {
    const client = transport({ route: 'proxy', environment: { HTTP_PROXY: 'http://user:password@proxy.test:8080' }, noProxy: '*.example.test,[::1]:443' });
    expect(client.describeRoute('http://origin.test')).toEqual({ route: 'proxy', proxyOrigin: 'http://proxy.test:8080', bypassed: false });
    expect(client.describeRoute('https://sub.example.test')).toEqual({ route: 'direct', bypassed: true });
    expect(client.describeRoute(new URL('https://[::1]'))).toEqual({ route: 'direct', bypassed: true });
    expect(() => client.describeRoute('https://origin.test')).toThrow(HttpTransportError);
    expect(() => client.describeRoute('file:///private?token=secret')).toThrow(HttpTransportError);
    const direct = transport({ route: 'direct' });
    expect(direct.describeRoute('https://origin.test')).toEqual({ route: 'direct', bypassed: false });
  });

  it('direct ignores proxy inputs and never changes the global dispatcher or environment', async () => {
    const server = own(await origin((_request, response) => response.end('direct')));
    const global = getGlobalDispatcher();
    const before = { ...process.env };
    const client = transport({ route: 'direct', environment: { HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'garbage', NO_PROXY: '*' }, proxyUrl: 'invalid' });
    expect(await (await client.fetch(server.url)).text()).toBe('direct');
    expect(getGlobalDispatcher()).toBe(global);
    expect(process.env).toEqual(before);
  });

  it.each([false, true])('tunnels HTTPS with proxy-side origin resolution (secure proxy=%s)', async secure => {
    const server = own(await origin((request, response) => { response.setHeader('x-test', 'ok'); response.end(request.url); }, true));
    const gateway = own(await proxy(server.port, { secure }));
    const client = transport({ route: 'proxy', proxyUrl: gateway.url, tls: { ca, proxyCa: ca } });
    const url = `https://origin.test:${server.port}/path?q=secret`;
    const response = await client.fetch(url);
    expect(response).toBeInstanceOf(Response);
    expect(response.url).toBe(url);
    expect(response.headers.get('x-test')).toBe('ok');
    expect(await response.text()).toBe('/path?q=secret');
    expect(gateway.requests).toEqual([`origin.test:${server.port}`]);
  });

  it('uses explicit proxyUrl over lowercase and uppercase env for both protocols', async () => {
    const http = own(await origin((_request, response) => response.end('ok')));
    const gateway = own(await proxy(http.port));
    const client = transport({ route: 'proxy', proxyUrl: gateway.url, environment: { http_proxy: 'http://127.0.0.1:1', HTTP_PROXY: 'invalid', HTTPS_PROXY: 'invalid' } });
    expect(await (await client.fetch(`http://origin.test:${http.port}`)).text()).toBe('ok');
    expect(gateway.requests).toEqual([`origin.test:${http.port}`]);
  });

  it('copies the environment and applies lowercase precedence for each protocol', async () => {
    const http = own(await origin((_request, response) => response.end('http')));
    const https = own(await origin((_request, response) => response.end('https'), true));
    const first = own(await proxy(http.port)), second = own(await proxy(https.port));
    const environment = { http_proxy: first.url, HTTP_PROXY: 'invalid', https_proxy: second.url, HTTPS_PROXY: 'invalid' };
    const client = transport({ route: 'proxy', environment, tls: { ca } });
    environment.http_proxy = 'http://127.0.0.1:1';
    environment.https_proxy = 'http://127.0.0.1:1';
    expect(await (await client.fetch(`http://origin.test:${http.port}`)).text()).toBe('http');
    expect(await (await client.fetch(`https://origin.test:${https.port}`)).text()).toBe('https');
    expect(first.requests).toHaveLength(1);
    expect(second.requests).toHaveLength(1);
  });

  it.each(['HTTP_PROXY', 'HTTPS_PROXY'])('uses uppercase %s when lowercase is absent', async key => {
    const secure = key === 'HTTPS_PROXY';
    const server = own(await origin((_request, response) => response.end('ok'), secure));
    const gateway = own(await proxy(server.port));
    const client = transport({ route: 'proxy', environment: { [key]: gateway.url }, tls: { ca } });
    expect(await (await client.fetch(`${secure ? 'https' : 'http'}://origin.test:${server.port}`)).text()).toBe('ok');
    expect(gateway.requests).toHaveLength(1);
  });

  it('empty lowercase overrides uppercase and missing HTTPS proxy never falls back to HTTP or direct', async () => {
    const server = own(await origin((_request, response) => response.end('must not arrive'), true));
    const gateway = own(await proxy(server.port));
    const client = transport({ route: 'proxy', environment: { http_proxy: gateway.url, https_proxy: '', HTTPS_PROXY: gateway.url }, tls: { ca } });
    expect(await category(client.fetch(server.url))).toEqual({ category: 'proxy-connect', retryable: true });
    expect(gateway.requests).toHaveLength(0);
  });

  it.each(['127.0.0.1', '*', 'unrelated.test, 127.0.0.1'])('NO_PROXY %s allows explicitly excluded direct requests', async noProxy => {
    const server = own(await origin((_request, response) => response.end('bypass')));
    const client = transport({ route: 'proxy', environment: { HTTP_PROXY: 'http://127.0.0.1:1', NO_PROXY: noProxy } });
    expect(await (await client.fetch(server.url)).text()).toBe('bypass');
  });

  it('NO_PROXY port must match and explicit empty noProxy overrides environment', async () => {
    const server = own(await origin((_request, response) => response.end('proxied')));
    const gateway = own(await proxy(server.port));
    for (const noProxy of [`127.0.0.1:${server.port + 1}`, '']) {
      const client = transport({ route: 'proxy', proxyUrl: gateway.url, environment: { NO_PROXY: '*' }, noProxy });
      expect(await (await client.fetch(server.url)).text()).toBe('proxied');
    }
    expect(gateway.requests).toHaveLength(2);
    const bypass = transport({ route: 'proxy', proxyUrl: 'http://127.0.0.1:1', noProxy: `127.0.0.1:${server.port}` });
    expect(await (await bypass.fetch(server.url)).text()).toBe('proxied');
  });

  it('lowercase no_proxy overrides uppercase even when empty', async () => {
    const server = own(await origin((_request, response) => response.end('proxied')));
    const gateway = own(await proxy(server.port));
    const client = transport({ route: 'proxy', proxyUrl: gateway.url, environment: { no_proxy: '', NO_PROXY: '*' } });
    await (await client.fetch(server.url)).text();
    expect(gateway.requests).toHaveLength(1);
  });

  it('NO_PROXY domains use label boundaries rather than substring matches', async () => {
    const server = own(await origin((_request, response) => response.end('proxy')));
    const gateway = own(await proxy(server.port));
    const client = transport({ route: 'proxy', proxyUrl: gateway.url, noProxy: '.origin.test' });
    expect(await category(client.fetch(`http://sub.origin.test:${server.port}`))).toEqual({ category: 'dns', retryable: true });
    expect(gateway.requests).toHaveLength(0);
    expect(await (await client.fetch(`http://notorigin.test:${server.port}`)).text()).toBe('proxy');
  });
});

describe('HTTP failures and strict security', () => {
  it('rejects invalid proxy URLs without exposing their contents', () => {
    for (const proxyUrl of ['socks5://user:password@host', 'not-a-url?token=secret', 'http://user:%ZZ@localhost', 'http://localhost/path?token=secret']) {
      let error;
      try { createNodeHttpTransport({ route: 'proxy', proxyUrl }); } catch (value) { error = value; }
      expect(error).toBeInstanceOf(HttpTransportError);
      expect(String(error)).not.toMatch(/password|secret|user|%ZZ/);
      expect(classifyHttpTransportError(error)).toEqual({ category: 'unknown', retryable: false });
    }
  });

  it('retains ordinary 401/407/500 responses and never follows redirects even on Request input', async () => {
    const paths: string[] = [];
    const server = own(await origin((request, response) => {
      paths.push(request.url ?? '');
      response.statusCode = Number(request.url?.slice(1));
      response.setHeader('location', '/200');
      response.end('business');
    }));
    const client = transport({ route: 'direct' });
    for (const status of [401, 407, 500, 302]) {
      const response = await client.fetch(new Request(`${server.url}/${status}`, { redirect: 'follow' }));
      expect(response.status).toBe(status);
      expect(response.redirected).toBe(false);
      expect(await response.text()).toBe('business');
    }
    expect(paths).toEqual(['/401', '/407', '/500', '/302']);
  });

  it('authenticates only to the proxy and never copies credentials into public errors', async () => {
    let originAuth: string | undefined;
    const server = own(await origin((request, response) => { originAuth = request.headers['proxy-authorization']; response.end('ok'); }, true));
    const gateway = own(await proxy(server.port, { authorization: 'Basic dXNlcjpwYXNz' }));
    const url = new URL(gateway.url); url.username = 'user'; url.password = 'pass';
    const good = transport({ route: 'proxy', proxyUrl: url.href, tls: { ca } });
    expect(await (await good.fetch(`https://origin.test:${server.port}`)).text()).toBe('ok');
    expect(originAuth).toBeUndefined();
    expect(gateway.authorizations).toEqual(['Basic dXNlcjpwYXNz']);
    url.password = 'wrong-password';
    const bad = transport({ route: 'proxy', proxyUrl: url.href, tls: { ca } });
    const error = await failure(bad.fetch(`https://origin.test:${server.port}/?token=secret`, { headers: { authorization: 'Bearer secret' } }));
    expect(classifyHttpTransportError(error)).toEqual({ category: 'proxy-auth', retryable: false });
    expect(error).toBeInstanceOf(HttpTransportError);
    expect(JSON.stringify(error) + String(error)).not.toMatch(/user|pass|secret|origin\.test|Bearer/);
    expect(Object.getOwnPropertyNames(error as Error)).not.toContain('cause');
  });

  it.each([403, 502])('classifies CONNECT %s and does not retry or fallback', async status => {
    let calls = 0;
    const server = own(await origin((_request, response) => { calls++; response.end('direct would work'); }));
    const gateway = own(await proxy(server.port, { status }));
    const client = transport({ route: 'proxy', proxyUrl: gateway.url });
    expect(await category(client.fetch(server.url, { method: 'POST', body: 'do not repeat' }))).toEqual({ category: 'proxy-connect', retryable: true });
    expect(gateway.requests).toHaveLength(1);
    expect(calls).toBe(0);
  });

  it('rejects untrusted origin and proxy certificates without making them retryable', async () => {
    const server = own(await origin((_request, response) => response.end('secure'), true));
    const direct = transport({ route: 'direct' });
    expect(await category(direct.fetch(server.url))).toEqual({ category: 'certificate', retryable: false });
    const gateway = own(await proxy(server.port, { secure: true }));
    const badProxy = transport({ route: 'proxy', proxyUrl: gateway.url, tls: { ca } });
    expect(await category(badProxy.fetch(`https://origin.test:${server.port}`))).toEqual({ category: 'certificate', retryable: false });
    expect(gateway.requests).toHaveLength(0);
  });

  it('classifies unavailable proxy connections while preserving DNS/timeout distinctions', async () => {
    const server = await origin((_request, response) => response.end());
    await server.close();
    const client = transport({ route: 'proxy', proxyUrl: server.url });
    expect(await category(client.fetch('https://origin.test'))).toEqual({ category: 'proxy-connect', retryable: true });
  });

  it('never replays a reset GET or POST request', async () => {
    let count = 0;
    const server = own(await origin((request) => { count++; request.socket.destroy(); }));
    const client = transport({ route: 'direct' });
    for (const method of ['GET', 'POST']) {
      expect(await category(client.fetch(server.url, { method }))).toEqual({ category: 'connection', retryable: true });
    }
    expect(count).toBe(2);
  });

  it('classifies abort deadline and arbitrary cancellation reason without leaking it', async () => {
    const seen = latch();
    const server = own(await origin(() => seen.resolve()));
    const client = transport({ route: 'direct' });
    const controller = new AbortController();
    const request = client.fetch(server.url, { signal: controller.signal });
    await seen.promise;
    controller.abort(new Error('secret abort reason'));
    const error = await failure(request);
    expect(classifyHttpTransportError(error)).toEqual({ category: 'cancelled', retryable: false });
    expect(String(error) + JSON.stringify(error)).not.toContain('secret');
    expect(await category(client.fetch(server.url, { signal: AbortSignal.timeout(100) }))).toEqual({ category: 'timeout', retryable: true });
  });

  it('times out a stalled proxy TLS handshake using instance connectTimeoutMs', async () => {
    const sockets = new Set<import('node:net').Socket>();
    const stalled = createServer(socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise<void>(resolve => stalled.listen(0, '127.0.0.1', resolve));
    const address = stalled.address();
    if (!address || typeof address === 'string') throw new Error('LOOPBACK_ADDRESS');
    cleanup.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => stalled.close(() => resolve())); });
    const client = transport({ route: 'proxy', proxyUrl: `https://127.0.0.1:${address.port}`, connectTimeoutMs: 50 });
    expect(await category(client.fetch('https://origin.test'))).toEqual({ category: 'timeout', retryable: true });
  });
});

describe('streams and owned resource lifecycle', () => {
  it('aborting a stalled CONNECT does not cancel another request on the same instance', async () => {
    const server = own(await origin((_request, response) => response.end('survivor')));
    const gatewayServer = await proxy(server.port, { stallHost: 'blocked.test' });
    const gateway = own(gatewayServer);
    const controller = new AbortController();
    const client = transport({ route: 'proxy', proxyUrl: gateway.url });
    const held = category(client.fetch(`https://blocked.test:${server.port}`, { signal: controller.signal }));
    await expect.poll(() => gateway.requests.length).toBe(1);
    const survivor = client.fetch(`http://origin.test:${server.port}`);
    controller.abort();
    expect(await held).toEqual({ category: 'cancelled', retryable: false });
    expect(await (await survivor).text()).toBe('survivor');
    expect(gateway.requests).toEqual([`blocked.test:${server.port}`, `origin.test:${server.port}`]);
    await client.close();
    await expect.poll(() => gateway.sockets.size).toBe(0);
  });

  it.each(['close', 'abort', 'connection-failure'])('cancels an upload source before the first upload read (%s)', async action => {
    const server = own(await origin((_request, response) => response.end()));
    const gateway = own(await proxy(server.port, { stall: true }));
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const controller = new AbortController();
    let proxyUrl = gateway.url;
    if (action === 'connection-failure') {
      const closed = await origin((_request, response) => response.end());
      proxyUrl = closed.url;
      await closed.close();
    }
    const client = transport({ route: 'proxy', proxyUrl });
    const init: RequestInit & { duplex: 'half' } = { method: 'POST', body, duplex: 'half', signal: controller.signal };
    const pending = category(client.fetch(`https://origin.test:${server.port}`, init));
    if (action !== 'connection-failure') {
      await expect.poll(() => gateway.requests.length).toBe(1);
      if (action === 'close') await client.close();
      else controller.abort();
    }
    expect(await pending).toEqual({ category: action === 'connection-failure' ? 'proxy-connect' : 'cancelled', retryable: action === 'connection-failure' });
    await expect.poll(() => cancelled).toBe(true);
    await expect.poll(() => gateway.sockets.size).toBe(0);
  });

  it.each(['close', 'abort'])('cancels unread decoded output after the compressed network body completed (%s)', async action => {
    const server = own(await origin((_request, response) => {
      response.writeHead(200, { 'content-encoding': 'gzip', connection: 'close' });
      response.end(gzipSync(new Uint8Array(256 * 1024).fill(65)));
    }));
    const controller = new AbortController();
    const client = transport({ route: 'direct' });
    const response = await client.fetch(server.url, { signal: controller.signal });
    await expect.poll(() => server.sockets.size).toBe(0);
    if (action === 'close') await client.close();
    else controller.abort(new Error('secret cancellation'));
    expect(await category(response.text())).toEqual({ category: 'cancelled', retryable: false });
  });

  it('decodes compressed HTTP responses with streaming errors kept private', async () => {
    const server = own(await origin((request, response) => {
      response.setHeader('content-encoding', 'gzip');
      response.end(request.url === '/bad' ? 'invalid gzip body' : gzipSync('compressed bytes'));
    }));
    const client = transport({ route: 'direct' });
    expect(await (await client.fetch(server.url)).text()).toBe('compressed bytes');
    expect(await category((await client.fetch(`${server.url}/bad`)).text())).toEqual({ category: 'unknown', retryable: false });
  });

  it.each([204, 205, 304])('preserves null body for status %s and HEAD', async status => {
    const server = own(await origin((_request, response) => { response.statusCode = status; response.end(); }));
    const client = transport({ route: 'direct' });
    for (const method of ['HEAD', 'GET']) {
      const response = await client.fetch(server.url, { method });
      expect(response.body).toBeNull();
      expect(await response.text()).toBe('');
    }
  });

  it('rejects malformed requests conservatively and close cancels a pending upload source', async () => {
    const client = transport({ route: 'direct' });
    expect(await category(client.fetch('file:///private?token=secret'))).toEqual({ category: 'unknown', retryable: false });
    expect(await category(client.fetch('http://127.0.0.1', { method: 'CONNECT' }))).toEqual({ category: 'unknown', retryable: false });
    const cancelled = latch(), seen = latch();
    const server = own(await origin(request => { request.on('data', () => seen.resolve()); }));
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1])); },
      cancel() { cancelled.resolve(); },
    });
    const init: RequestInit & { duplex: 'half' } = { method: 'POST', body, duplex: 'half' };
    const pending = category(client.fetch(server.url, init));
    await seen.promise;
    await client.close();
    expect(await pending).toEqual({ category: 'cancelled', retryable: false });
    await cancelled.promise;
  });

  it('close interrupts an active response reader without exposing the underlying error', async () => {
    const server = own(await origin((_request, response) => { response.write('first'); }));
    const client = transport({ route: 'direct' });
    const reader = bodyOf(await client.fetch(server.url)).getReader();
    expect((await reader.read()).value?.byteLength).toBe(5);
    const next = category(reader.read());
    await client.close();
    expect(await next).toEqual({ category: 'cancelled', retryable: false });
  });

  it('streams response data before completion and preserves clone, status, headers and byte size', async () => {
    const finish = latch(), started = latch();
    const block = new Uint8Array(128 * 1024).fill(65);
    const server = own(await origin((_request, response) => {
      response.statusCode = 206;
      response.setHeader('x-stream', 'yes');
      response.write(block);
      started.resolve();
      void finish.promise.then(() => response.end(block));
    }));
    const client = transport({ route: 'direct' });
    const response = await client.fetch(server.url);
    await started.promise;
    const copy = response.clone();
    expect(copy.url).toBe(server.url + '/');
    const reader = bodyOf(response).getReader();
    const first = await reader.read();
    expect(first.value?.byteLength).toBeGreaterThan(0);
    expect(response.status).toBe(206);
    expect(response.headers.get('x-stream')).toBe('yes');
    finish.resolve();
    let size = first.value?.byteLength ?? 0;
    for (;;) { const value = await reader.read(); if (value.done) break; size += value.value.byteLength; }
    expect(size).toBe(262144);
    expect((await copy.arrayBuffer()).byteLength).toBe(262144);
  });

  it('supports streaming request body and native Request overrides', async () => {
    const server = own(await origin((request, response) => { request.pipe(response); }));
    const client = transport({ route: 'direct' });
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('streamed')); controller.close(); } });
    const init: RequestInit & { duplex: 'half' } = { method: 'POST', body: stream, duplex: 'half' };
    expect(await (await client.fetch(new Request(server.url, init), { headers: { 'x-test': 'yes' } })).text()).toBe('streamed');
  });

  it('sanitizes response stream errors and releases a cancelled body', async () => {
    const server = own(await origin((_request, response) => { response.writeHead(200); response.write('first'); }));
    const client = transport({ route: 'direct' });
    const controller = new AbortController();
    const response = await client.fetch(server.url, { signal: controller.signal });
    controller.abort(new Error('secret stream abort'));
    const error = await failure(response.text());
    expect(classifyHttpTransportError(error)).toEqual({ category: 'cancelled', retryable: false });
    expect(String(error) + JSON.stringify(error)).not.toContain('secret');
    const next = await client.fetch(server.url);
    await bodyOf(next).cancel('secret cancel reason');
    await client.close();
    await expect.poll(() => server.sockets.size).toBe(0);
  });

  it('close destroys successful, failed, pending and unread bodies and is idempotent', async () => {
    const pending = latch();
    const server = own(await origin((request, response) => {
      if (request.url === '/pending') { pending.resolve(); return; }
      if (request.url === '/fail') { request.socket.destroy(); return; }
      if (request.url === '/unread') { response.writeHead(200); response.write('unread'); return; }
      response.end('success');
    }));
    const client = transport({ route: 'direct' });
    expect(await (await client.fetch(server.url)).text()).toBe('success');
    expect(await category(client.fetch(`${server.url}/fail`))).toEqual({ category: 'connection', retryable: true });
    const unread = await client.fetch(`${server.url}/unread`);
    const inFlight = category(client.fetch(`${server.url}/pending`));
    await pending.promise;
    await Promise.all([client.close(), client.close()]);
    expect(await inFlight).toEqual({ category: 'cancelled', retryable: false });
    expect(await category(unread.text())).toEqual({ category: 'cancelled', retryable: false });
    expect(await category(client.fetch(server.url))).toEqual({ category: 'cancelled', retryable: false });
    await expect.poll(() => server.sockets.size).toBe(0);
  });

  it('closing one proxy instance leaves another independent instance usable', async () => {
    const server = own(await origin((_request, response) => response.end('ok'), true));
    const gateway = own(await proxy(server.port));
    const first = transport({ route: 'proxy', proxyUrl: gateway.url, tls: { ca } });
    const second = transport({ route: 'proxy', proxyUrl: gateway.url, tls: { ca } });
    await (await first.fetch(`https://origin.test:${server.port}`)).text();
    await first.close();
    expect(await (await second.fetch(`https://origin.test:${server.port}`)).text()).toBe('ok');
    await second.close();
    await expect.poll(() => gateway.sockets.size + gateway.upstreams.size + server.sockets.size).toBe(0);
  });
});
