import { fixture } from './helpers/prebuilt-publication-fixture.js';
import { readFile } from 'node:fs/promises';
import { createServer as httpServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { connect, type Socket } from 'node:net';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setImmediate as immediate } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runRelease } from '../src/node.js';
import type { PrebuiltReleaseState, RunReleaseOptions } from '../src/index.js';
import { Execution } from '../src/node/execution.js';
import { createPrebuiltTransport, PrebuiltVerification } from '../src/node/prebuilt-vercel.js';
import { createCandidateMarkerHeaders } from '../src/node/candidate-marker-auth.js';
import * as buildInfoHttp from '../src/node/build-info-http.js';
import { prebuiltConfiguration } from './helpers/prebuilt-configuration.js';

const api = vi.hoisted(() => ({ origin: '' }));
// 仅重定向原生 provider API 的固定地址，保留请求方法、请求头、响应和连接关闭。
vi.mock('node:https', async original => ({ ...await original<typeof import('node:https')>(),
  request: (url: URL, options: import('node:https').RequestOptions, callback: (response: IncomingMessage) => void) => {
    if (!api.origin || url.origin !== 'https://api.vercel.com') throw new Error('unexpected fixture API origin');
    return httpRequest(new URL(`${url.pathname}${url.search}`, api.origin), options, callback);
  } }));

const candidate = { deploymentId: 'dpl_candidate', origin: 'https://candidate.vercel.app', projectId: 'prj_fixture', teamId: 'team_fixture' };
const providerCandidate = { id: candidate.deploymentId, url: candidate.origin, projectId: candidate.projectId,
  ownerId: candidate.teamId, target: 'production', source: 'cli', readyState: 'READY' };
const tokenHeader = 'x-vercel-trusted-oidc-idp-token';
const token = 'candidate-credential-fixture';
const cookie = 'fixture-access=private';
const auth = { origin: candidate.origin, headers: { [tokenHeader]: token, cookie } };
const marker = { schemaVersion: 1, sourceSha: 'a'.repeat(40), configSha256: 'b'.repeat(64), artifactSha256: 'c'.repeat(64) };
const state: PrebuiltReleaseState = { ...marker, deploymentId: candidate.deploymentId, deploymentUrl: candidate.origin,
  fileCount: 1, byteLength: 1, createEffect: 'accepted', promoteEffect: 'not-attempted', acceptanceVerified: false, promotionVerified: false };
const disposals: (() => Promise<void>)[] = [];

beforeEach(() => vi.stubEnv('VERCEL_TOKEN', 'provider-token-fixture'));
afterEach(async () => {
  try { for (const dispose of disposals.splice(0).reverse()) await dispose(); }
  finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); api.origin = ''; }
});

async function listen(server: ReturnType<typeof httpServer> | ReturnType<typeof httpsServer>) {
  const sockets = new Set<Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  disposals.push(async () => {
    const closed = new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
    for (const socket of sockets) socket.destroy();
    await closed;
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture port required');
  return { port: address.port, sockets, origin: `http://127.0.0.1:${address.port}` };
}

async function network(provider: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void,
  reply: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void, versionHost?: string) {
  type Request = { method: string | undefined; path: string | undefined; headers: IncomingMessage['headers'] };
  const providerRequests: Request[] = [], markerRequests: Request[] = [], tunnels: Request[] = [];
  function capture(requests: Request[], handler: typeof provider) {
    return (request: IncomingMessage, response: ServerResponse) => {
      requests.push({ method: request.method, path: request.url, headers: request.headers });
      void Promise.resolve().then(() => handler(request, response)).catch(() => {
        if (response.headersSent) response.destroy();
        else { response.writeHead(500); response.end(); }
      });
    };
  }
  const pem = (name: string) => readFile(new URL(`./fixtures/candidate-marker/${name}.pem`, import.meta.url));
  const [cert, key] = await Promise.all([pem('cert'), pem('key')]);
  const site = await listen(httpsServer({ cert, key }, capture(markerRequests, reply)));
  api.origin = (await listen(httpServer(capture(providerRequests, provider)))).origin;
  const gateway = httpServer();
  gateway.on('connect', (request, client, head) => {
    tunnels.push({ method: request.method, path: request.url, headers: request.headers });
    if (!['candidate.vercel.app:443', 'fixture.example.invalid:443', `${versionHost}:443`].includes(request.url ?? '')) {
      client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return;
    }
    const upstream = connect(site.port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    client.on('error', () => upstream.destroy()); client.once('close', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
  });
  const proxy = await listen(gateway);
  return { http: { route: 'proxy' as const, environment: { HTTPS_PROXY: proxy.origin }, tls: { ca: cert.toString('utf8') } },
    providerRequests, markerRequests, tunnels, sockets: () => site.sockets.size + proxy.sockets.size };
}

it('binds credentials after native candidate observation and shares them through publish and completion', async () => {
  const acceptance = [{ command: 'node', args: ['-e',
    `const samples = ${JSON.stringify([token, cookie].map(value => Buffer.from(value).toString('base64')))}.map(value => Buffer.from(value, 'base64').toString()); if (Object.values(process.env).some(value => samples.some(sample => value.includes(sample)))) process.exit(1);`] }];
  // 两次受管别名查询和两次真实 TLS 读取共用阶段预算，单次请求仍限 1 秒。
  const value = await fixture(true, acceptance, { idempotent: true, jobs: [{ command: 'node', args: ['-e', 'process.exit(0)'] }] },
    { deploymentMs: 10_000 });
  const versionHost = `fixture-${value.sha}.vercel.app`;
  const networkFixture = await network(async (request, response) => {
    const path = request.url ?? '', method = request.method;
    let result: unknown;
    if (method === 'POST' && path.startsWith('/v10/projects/')) {
      await value.transport.promote?.(candidate.deploymentId, new AbortController().signal);
      response.writeHead(201); response.end(); return;
    }
    if (method === 'POST' && path.startsWith('/v2/deployments/')) result = await value.transport.versionAlias?.assign?.(candidate.deploymentId, versionHost, new AbortController().signal);
    else if (path.startsWith(`/v4/aliases/${versionHost}?`)) {
      result = await value.transport.versionAlias?.read(versionHost, new AbortController().signal);
      if (!result) response.statusCode = 404;
    } else result = await value.transport.api(path, new AbortController().signal);
    response.end(JSON.stringify(result ?? {}));
  }, async (request, response) => {
    if (request.headers.host === 'candidate.vercel.app' && request.headers[tokenHeader] !== token) {
      response.writeHead(302, { location: '/sso-api' }); response.end(); return;
    }
    response.end(JSON.stringify(await value.transport.buildInfo(`https://${request.headers.host}${request.url}`, new AbortController().signal)));
  }, versionHost);
  const candidateMarkerAuth = vi.fn(async () => auth);
  const options = { command: 'publish' as const, cwd: value.cwd, buildInfoHttp: networkFixture.http, candidateMarkerAuth };
  const report = await runRelease(options);
  expect(report, JSON.stringify({ error: report.error, steps: report.steps.slice(-2),
    providerPaths: networkFixture.providerRequests.map(({ method, path }) => [method, path]),
    markerHosts: networkFixture.markerRequests.map(({ headers }) => headers.host) })).toMatchObject({ ok: true,
    completion: { status: 'completed' }, effects: { deploymentPromote: 'accepted' } });
  expect(candidateMarkerAuth).toHaveBeenCalledExactlyOnceWith(candidate, expect.any(AbortSignal));
  expect(await value.creates()).toBe(1);
  expect(networkFixture.providerRequests.filter(request => request.method === 'POST' && request.path?.includes('/promote/')))
    .toEqual([expect.objectContaining({ path: '/v10/projects/prj_fixture/promote/dpl_candidate?teamId=team_fixture' })]);
  const projectReads = networkFixture.providerRequests.filter(request => request.method === 'GET' && request.path?.startsWith('/v9/projects/'));
  expect(projectReads.length).toBeGreaterThan(0);
  for (const request of projectReads) expect(request.path).toBe('/v9/projects/prj_fixture?rollbackInfo=true&teamId=team_fixture');
  for (const request of networkFixture.providerRequests) expect(request.headers.authorization).toBe('Bearer provider-token-fixture');
  const protectedReads = networkFixture.markerRequests.filter(request => request.headers.host === 'candidate.vercel.app');
  expect(protectedReads.length).toBeGreaterThan(2);
  for (const request of protectedReads) {
    expect(request).toMatchObject({ method: 'GET', path: `/.well-known/forge-prebuilt.json?artifact=${report.prebuilt?.artifactSha256}`,
      headers: { [tokenHeader]: token, cookie } });
  }
  expect(networkFixture.markerRequests.map(request => request.headers.host)).toEqual(expect.arrayContaining([versionHost, 'fixture.example.invalid']));
  for (const request of [...networkFixture.providerRequests, ...networkFixture.tunnels, ...networkFixture.markerRequests.filter(item => !protectedReads.includes(item))]) {
    expect(request.headers[tokenHeader]).toBeUndefined();
    expect(request.headers.cookie).toBeUndefined();
  }
  for (const contents of [JSON.stringify(report), await readFile(resolve(value.cwd, 'state/release-slot/latest-publish.json'), 'utf8'),
    await readFile(resolve(value.cwd, 'state/release-slot/state.json'), 'utf8')]) {
    expect(contents).not.toContain(token);
    expect(contents).not.toContain(cookie);
  }
  const status = await runRelease({ ...options, command: 'status' });
  expect(status, JSON.stringify(status.error)).toMatchObject({ ok: true, deployment: { id: candidate.deploymentId } });
  expect(candidateMarkerAuth).toHaveBeenCalledTimes(2);
  expect(value.promotions()).toBe(1);
  await expect.poll(networkFixture.sockets).toBe(0);
}, 300_000);

it.each(['redirect', 'digest', 'origin', 'identity', 'changed-url', 'not-ready', 'resolver-error', 'invalid-header', 'production-origin', 'cancel'] as const)(
  'fails closed on %s', async mode => {
  const networkFixture = await network((_request, response) => {
    response.end(JSON.stringify({ ...providerCandidate, ...(mode === 'identity' ? { ownerId: 'team_other' } : {}),
      ...(mode === 'changed-url' ? { url: 'https://other.vercel.app' } : {}), ...(mode === 'not-ready' ? { readyState: 'ERROR' } : {}) }));
  }, (_request, response) => {
    if (mode === 'redirect') response.writeHead(302, { location: 'https://fixture.example.invalid/sso-api' });
    response.end(JSON.stringify({ ...marker, artifactSha256: 'd'.repeat(64) }));
  });
  const base = prebuiltConfiguration();
  const config = { ...base, vercel: { ...base.vercel, productionUrl: mode === 'production-origin' ? candidate.origin : base.vercel.productionUrl },
    limits: { ...base.limits, deploymentMs: 3000, requestMs: 2000 } };
  const stop = new AbortController();
  const readBuildInfo = vi.spyOn(buildInfoHttp, 'readBuildInfo');
  let finishAuth: (() => void) | undefined;
  const resolver = vi.fn(async () => {
    if (mode === 'resolver-error') throw new Error(token);
    if (mode === 'cancel') {
      stop.abort();
      await new Promise<void>(accept => { finishAuth = accept; });
    }
    if (mode === 'origin') return { ...auth, origin: 'https://fixture.example.invalid' };
    if (mode === 'invalid-header') return { ...auth, headers: { ...auth.headers, host: 'fixture.example.invalid' } };
    return auth;
  });
  const access = createPrebuiltTransport(new Execution(process.cwd(), config, undefined, []), config, false, networkFixture.http, undefined,
    createCandidateMarkerHeaders(resolver));
  const error: unknown = await new PrebuiltVerification(config, access, stop.signal).ready(state).catch((failure: unknown) => failure);
  if (finishAuth) { finishAuth(); await immediate(); }
  const expected = { redirect: { code: 'BUILD_INFO', details: { status: 302 } }, digest: { code: 'ARTIFACT_CHANGED' },
    origin: { code: 'AUTH_REQUIRED', details: { reason: 'CANDIDATE_MARKER_ORIGIN' } }, identity: { code: 'DEPLOYMENT_SOURCE' },
    'changed-url': { code: 'DEPLOYMENT_SOURCE', details: { reason: 'CANDIDATE_URL_CHANGED' } }, 'not-ready': { code: 'DEPLOYMENT_FAILED' },
    'resolver-error': { code: 'AUTH_REQUIRED', details: { reason: 'CANDIDATE_MARKER_AUTH_FAILED' } },
    'invalid-header': { code: 'AUTH_REQUIRED', details: { reason: 'CANDIDATE_MARKER_HEADERS' } },
    'production-origin': { code: 'AUTH_REQUIRED', details: { reason: 'CANDIDATE_MARKER_ORIGIN' } },
    cancel: { code: 'CANCELLED' } };
  expect(error).toMatchObject(expected[mode]);
  expect(JSON.stringify(error)).not.toContain(token);
  expect(resolver).toHaveBeenCalledTimes(['identity', 'changed-url', 'not-ready', 'production-origin'].includes(mode) ? 0 : 1);
  expect(readBuildInfo).toHaveBeenCalledTimes(mode === 'redirect' || mode === 'digest' ? 1 : 0);
  expect(networkFixture.markerRequests.map(request => request.headers.host)).toEqual(mode === 'redirect' || mode === 'digest' ? ['candidate.vercel.app'] : []);
  await expect.poll(networkFixture.sockets).toBe(0);
});

it('preserves managed options implemented as prototype getters', async () => {
  const options = new class implements RunReleaseOptions {
    #config = prebuiltConfiguration();
    get command() { return 'publish' as const; }
    get cwd() { return resolve(import.meta.dirname, '..'); }
    get config() { return this.#config; }
  }();
  expect(await runRelease(options)).toMatchObject({ command: 'publish', ok: false,
    error: { code: 'SOURCE_UNSUPPORTED', details: { reason: 'COMMITTED_CONFIG_REQUIRED' } } });
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(accept => { release = accept; });
  return { promise, release };
}

it.each(['reply', 'timeout', 'late-reply', 'late-credentials'] as const)('honors the candidate credential and HTTP deadlines for %s', async mode => {
  const credentialsStarted = gate(), credentialsReady = gate(), markerReceived = gate(), transportClosed = gate(), returnRead = gate();
  const networkFixture = await network((_request, response) => { response.end(JSON.stringify(providerCandidate)); }, (_request, response) => {
    markerReceived.release();
    if (mode !== 'timeout') response.end(JSON.stringify(marker));
  });
  const base = prebuiltConfiguration(), requestMs = 1827;
  const config = { ...base, limits: { ...base.limits, requestMs, deploymentMs: 10_000 } };
  const requestTimers: AbortController[] = [];
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    if (ms !== requestMs) return timeout(ms);
    const timer = new AbortController(); requestTimers.push(timer); return timer.signal;
  });
  const read = buildInfoHttp.readBuildInfo;
  if (mode === 'timeout' || mode === 'late-reply') vi.spyOn(buildInfoHttp, 'readBuildInfo').mockImplementation(async (...args) => {
    try {
      const value = await read(...args);
      if (mode === 'late-reply') {
        const now = performance.now.bind(performance);
        vi.spyOn(performance, 'now').mockImplementation(() => now() + requestMs + 1);
      }
      return value;
    } finally {
      if (mode === 'timeout') { transportClosed.release(); await returnRead.promise; }
    }
  });
  const headers = createCandidateMarkerHeaders(async () => {
    credentialsStarted.release(); await credentialsReady.promise; return auth;
  });
  const caller = new AbortController();
  const access = createPrebuiltTransport(new Execution(process.cwd(), config, undefined, []), config, false,
    networkFixture.http, undefined, headers);
  let settled = false;
  const result = new PrebuiltVerification(config, access, caller.signal).ready(state)
    .then(value => ({ value }), (error: unknown) => ({ error })).finally(() => { settled = true; });
  try {
    await credentialsStarted.promise;
    expect(requestTimers).toHaveLength(0);
    expect(networkFixture.markerRequests).toEqual([]);
    expect(settled).toBe(false);
    if (mode === 'late-credentials') {
      const now = Date.now.bind(Date);
      vi.spyOn(Date, 'now').mockImplementation(() => now() + config.limits.deploymentMs + 1);
      credentialsReady.release();
      expect(await result).toMatchObject({ error: { code: 'AUTH_REQUIRED', details: { reason: 'CANDIDATE_MARKER_AUTH_TIMEOUT' } } });
      expect(networkFixture.markerRequests).toEqual([]);
      expect(requestTimers).toHaveLength(0);
      return;
    }
    credentialsReady.release();
    await markerReceived.promise;
    expect(requestTimers).toHaveLength(1);
    expect(networkFixture.markerRequests).toEqual([expect.objectContaining({ method: 'GET',
      path: `/.well-known/forge-prebuilt.json?artifact=${marker.artifactSha256}`, headers: expect.objectContaining(auth.headers) })]);
    if (mode === 'timeout') {
      requestTimers[0]?.abort();
      await transportClosed.promise; await immediate();
      expect(settled).toBe(false);
      returnRead.release();
      expect(await result).toMatchObject({ error: { code: 'VERCEL_API', details: { reason: 'REQUEST_TIMEOUT' } } });
    } else if (mode === 'late-reply') {
      expect(await result).toMatchObject({ error: { code: 'VERCEL_API', details: { reason: 'REQUEST_TIMEOUT' } } });
    } else expect(await result).toMatchObject({ value: { id: candidate.deploymentId, state: 'READY' } });
    await expect.poll(networkFixture.sockets).toBe(0);
  } finally {
    caller.abort(); credentialsReady.release(); returnRead.release(); await result;
  }
});
