import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prebuiltConfiguration } from './helpers/prebuilt-configuration.js';

const target = vi.hoisted(() => ({ origin: '' }));
// 只替换 TLS 连接目标；实际 Node request、正文、取消、超时及 socket 关闭均保持真实。
vi.mock('node:https', async importOriginal => {
  const original = await importOriginal<typeof import('node:https')>();
  const { request } = await import('node:http');
  return { ...original, request: (url: URL, options: import('node:https').RequestOptions, callback: (response: IncomingMessage) => void) => {
    expect(url.origin).toBe('https://api.vercel.com');
    expect(options.headers).toMatchObject({ authorization: 'Bearer fixture-token', 'content-type': 'application/json' });
    return request(new URL(`${url.pathname}${url.search}`, target.origin), options, callback);
  } };
});
import { promotePrebuiltOnce } from '../src/node/prebuilt-vercel.js';

let server: ReturnType<typeof createServer>;
let reply: (request: IncomingMessage, response: ServerResponse) => void;
let requests: { method: string | undefined; url: string | undefined; body: string }[];
let sockets: Set<Socket>, closures: Promise<void>[];
let previousToken: string | undefined;
beforeEach(async () => {
  previousToken = process.env.VERCEL_TOKEN; process.env.VERCEL_TOKEN = 'fixture-token';
  requests = []; sockets = new Set(); closures = [];
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
  target.origin = '';
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
