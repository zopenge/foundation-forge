import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prebuiltConfiguration } from './helpers/prebuilt-configuration.js';

const target = vi.hoisted(() => ({ origin: '', omitDestroyError: false }));
// 连接与正文均真实；特定用例抑制destroy错误通知，覆盖错误未派发的完成时序。
vi.mock('node:https', async importOriginal => {
  const original = await importOriginal<typeof import('node:https')>();
  const { request } = await import('node:http');
  return { ...original, request: (url: URL, options: import('node:https').RequestOptions, callback: (response: IncomingMessage) => void) => {
    expect(url.origin).toBe('https://api.vercel.com');
    expect(options.headers).toMatchObject({ authorization: 'Bearer fixture-token', 'content-type': 'application/json' });
    const connection = request(new URL(`${url.pathname}${url.search}`, target.origin), options, callback);
    if (target.omitDestroyError) { const destroy = connection.destroy.bind(connection); connection.destroy = () => destroy(); }
    return connection;
  } };
});
import { createPrebuiltTransport, promotePrebuiltOnce } from '../src/node/prebuilt-vercel.js';
import { Execution } from '../src/node/execution.js';

let server: ReturnType<typeof createServer>;
let reply: (request: IncomingMessage, response: ServerResponse) => void;
let requests: { method: string | undefined; url: string | undefined; body: string }[];
let sockets: Set<Socket>, closures: Promise<void>[];
let previousToken: string | undefined;
beforeEach(async () => {
  previousToken = process.env.VERCEL_TOKEN; process.env.VERCEL_TOKEN = 'fixture-token';
  requests = []; sockets = new Set(); closures = []; target.omitDestroyError = false;
  reply = (_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}'); };
  server = createServer((request, response) => {
    let body = ''; request.on('data', chunk => { body += String(chunk); });
    request.on('end', () => { requests.push({ method: request.method, url: request.url, body }); reply(request, response); });
  });
  server.on('connection', socket => {
    sockets.add(socket); closures.push(new Promise<void>(accept => { socket.once('close', () => { sockets.delete(socket); accept(); }); }));
  });
  await new Promise<void>(accept => { server.listen(0, '127.0.0.1', accept); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture address required');
  target.origin = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((accept, reject) => { server.close(error => { if (error) reject(error); else accept(); }); });
  if (previousToken === undefined) delete process.env.VERCEL_TOKEN; else process.env.VERCEL_TOKEN = previousToken;
  target.origin = ''; target.omitDestroyError = false;
});
async function assertClosed(): Promise<void> { await Promise.all(closures); expect(sockets.size).toBe(0); }

describe('single public API promotion with real socket ownership', () => {
  it('submits one exact production promotion and resolves only after connection closure', async () => {
    await promotePrebuiltOnce(prebuiltConfiguration(), 'dpl_candidate', new AbortController().signal);
    await assertClosed();
    expect(requests).toEqual([{ method: 'POST', url: '/v10/projects/prj_fixture/promote/dpl_candidate?teamId=team_fixture', body: '{}' }]);
  });
  it('does not retry when the accepted request loses its response', async () => {
    reply = request => { request.socket.destroy(); };
    await expect(promotePrebuiltOnce(prebuiltConfiguration(), 'dpl_candidate', new AbortController().signal)).rejects.toMatchObject({ code: 'VERCEL_API' });
    await assertClosed(); expect(requests).toHaveLength(1);
  });
  it('does not retry a server error', async () => {
    reply = (_request, response) => { response.writeHead(503); response.end('unavailable'); };
    await expect(promotePrebuiltOnce(prebuiltConfiguration(), 'dpl_candidate', new AbortController().signal)).rejects.toMatchObject({ code: 'VERCEL_API' });
    await assertClosed(); expect(requests).toHaveLength(1);
  });
  it('bounds a stalled response and closes the live request', async () => {
    reply = () => {}; const config = prebuiltConfiguration();
    await expect(promotePrebuiltOnce(config, 'dpl_candidate', new AbortController().signal)).rejects.toMatchObject({ code: 'VERCEL_API', details: { reason: 'REQUEST_TIMEOUT' } });
    await assertClosed(); expect(requests).toHaveLength(1);
  });
  it('cancels and closes a live request without resubmitting', async () => {
    const controller = new AbortController(); reply = () => { controller.abort(); };
    await expect(promotePrebuiltOnce(prebuiltConfiguration(), 'dpl_candidate', controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    await assertClosed(); expect(requests).toHaveLength(1);
  });
  it('rejects missing credentials before transmitting anything', async () => {
    delete process.env.VERCEL_TOKEN;
    await expect(promotePrebuiltOnce(prebuiltConfiguration(), 'dpl_candidate', new AbortController().signal)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(requests).toHaveLength(0);
  });
});

describe('version alias HTTP boundary', () => {
  const hostname = `fixture-${'a'.repeat(40)}.vercel.app`;
  function adapter() {
    const config = prebuiltConfiguration();
    Object.assign(config.delivery, { versionAlias: { hostnameTemplate: 'fixture-{sha}.vercel.app' } });
    return createPrebuiltTransport(new Execution(process.cwd(), config, undefined, []), config, true).versionAlias;
  }
  const binding = { alias: hostname, uid: 'alias_fixture', deploymentId: 'dpl_candidate', projectId: 'prj_fixture' };
  it('reads the exact hostname in the team without filtering away foreign-project conflicts', async () => {
    reply = (_request, response) => { response.end(JSON.stringify(binding)); };
    const result = await adapter()?.read(hostname, new AbortController().signal);
    await assertClosed();
    expect(result).toEqual({ alias: hostname, deploymentId: 'dpl_candidate', projectId: 'prj_fixture', routing: 'direct' });
    expect(requests).toEqual([{ method: 'GET', url: `/v4/aliases/${hostname}?teamId=team_fixture`, body: '' }]);
  });
  it('only interprets a real 404 response as an absent alias', async () => {
    reply = (_request, response) => { response.writeHead(404); response.end('{"error":{"code":"not_found"}}'); };
    expect(await adapter()?.read(hostname, new AbortController().signal)).toBeUndefined();
    await assertClosed(); expect(requests).toHaveLength(1);
  });
  it.each([401, 403, 503])('retains HTTP %i as a failure instead of absence', async status => {
    reply = (_request, response) => { response.writeHead(status); response.end('{}'); };
    await expect(Promise.resolve(adapter()?.read(hostname, new AbortController().signal)))
      .rejects.toMatchObject({ code: status === 503 ? 'VERCEL_API' : 'AUTH_REQUIRED' });
    await assertClosed(); expect(requests).toHaveLength(1);
  });
  it.each([{ redirect: 'other.vercel.app' }, { microfrontends: {} }, { deletedAt: 1 }])('rejects indirect or deleted alias routes %j', async patch => {
    reply = (_request, response) => { response.end(JSON.stringify({ ...binding, ...patch })); };
    await expect(Promise.resolve(adapter()?.read(hostname, new AbortController().signal)))
      .rejects.toMatchObject({ code: 'VERSION_ALIAS_CONFLICT' });
    await assertClosed();
  });
  it('submits one exact alias assignment and returns only the public acknowledgement', async () => {
    reply = (_request, response) => { response.end(JSON.stringify({ alias: hostname, uid: 'alias_fixture' })); };
    const result = await adapter()?.assign?.('dpl_candidate', hostname, new AbortController().signal);
    await assertClosed(); expect(result).toEqual({ alias: hostname, uid: 'alias_fixture' });
    expect(requests).toEqual([{ method: 'POST', url: '/v2/deployments/dpl_candidate/aliases?teamId=team_fixture', body: JSON.stringify({ alias: hostname }) }]);
  });
  it('does not retry an alias assignment whose accepted response is lost', async () => {
    reply = request => { request.socket.destroy(); };
    await expect(Promise.resolve(adapter()?.assign?.('dpl_candidate', hostname, new AbortController().signal)))
      .rejects.toMatchObject({ code: 'VERCEL_API' });
    await assertClosed(); expect(requests).toHaveLength(1);
  });
  it('does not retry a rejected alias assignment', async () => {
    reply = (_request, response) => { response.writeHead(503); response.end('unavailable'); };
    await expect(Promise.resolve(adapter()?.assign?.('dpl_candidate', hostname, new AbortController().signal)))
      .rejects.toMatchObject({ code: 'VERCEL_API' });
    await assertClosed(); expect(requests).toHaveLength(1);
  });
  it('bounds and closes an alias request whose response never completes', async () => {
    reply = () => {};
    await expect(Promise.resolve(adapter()?.assign?.('dpl_candidate', hostname, new AbortController().signal)))
      .rejects.toMatchObject({ code: 'VERCEL_API', details: { reason: 'REQUEST_TIMEOUT' } });
    await assertClosed(); expect(requests).toHaveLength(1);
  });
  it('cancels an in-flight alias assignment and waits for connection closure', async () => {
    const controller = new AbortController(); reply = () => { controller.abort(); };
    await expect(Promise.resolve(adapter()?.assign?.('dpl_candidate', hostname, controller.signal)))
      .rejects.toMatchObject({ code: 'CANCELLED' });
    await assertClosed(); expect(requests).toHaveLength(1);
  });
  it('bounds alias responses without exposing raw response bodies', async () => {
    reply = (_request, response) => { response.end('secret-fixture'.repeat(1000)); };
    await expect(Promise.resolve(adapter()?.assign?.('dpl_candidate', hostname, new AbortController().signal)))
      .rejects.toMatchObject({ code: 'VERCEL_API', details: { reason: 'OUTPUT_LIMIT' } });
    await assertClosed(); expect(requests).toHaveLength(1);
  });
  it.each([{ mode: 'body', reason: 'OUTPUT_LIMIT' }, { mode: 'deadline', reason: 'REQUEST_TIMEOUT' }])(
    'preserves the $mode failure even when destroy emits no request error', async ({ mode, reason }) => {
      target.omitDestroyError = true;
      reply = mode === 'body' ? (_request, response) => { response.end('secret-fixture'.repeat(1000)); } : () => {};
      const error: unknown = await Promise.resolve(adapter()?.assign?.('dpl_candidate', hostname, new AbortController().signal)).catch((error: unknown) => error);
      expect(error).toMatchObject({ code: 'VERCEL_API', details: { reason } });
      expect(JSON.stringify(error)).not.toContain('secret-fixture');
      await assertClosed(); expect(requests).toHaveLength(1);
    });
});
