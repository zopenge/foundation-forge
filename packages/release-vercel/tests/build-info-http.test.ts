import { createServer } from 'node:http';
import { connect, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createTransport } from '../src/node/vercel.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()?.(); });
async function listen(server: ReturnType<typeof createServer>) {
  const sockets = new Set<Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('FIXTURE_ADDRESS');
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return { port: address.port, sockets, url: `http://127.0.0.1:${address.port}` };
}
const execution = (maxOutputBytes = 1024) => ({
  config: { limits: { maxOutputBytes, commandMs: 1000, deploymentMs: 1000, pollMs: 20, requestMs: 1000 } },
  run: async () => { throw new Error('CLI_MUST_NOT_RUN_FOR_BUILD_INFO'); },
});

describe('Vercel build-info HTTP adapter', () => {
  it('uses the explicit proxy snapshot and releases the per-read dispatcher', async () => {
    const server = await listen(createServer((_request, response) => response.end('{"revision":"fixture"}')));
    const authorities: string[] = [];
    const gatewayServer = createServer();
    gatewayServer.on('connect', (request, client) => {
      authorities.push(request.url ?? '');
      const upstream = connect(server.port, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        client.pipe(upstream).pipe(client);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
      client.once('close', () => upstream.destroy());
    });
    const gateway = await listen(gatewayServer);
    const transport = createTransport(execution(), { route: 'proxy', environment: { HTTP_PROXY: gateway.url } });
    expect(await transport.buildInfo(`http://origin.test:${server.port}/build-info.json`, new AbortController().signal)).toEqual({ revision: 'fixture' });
    expect(authorities).toEqual([`origin.test:${server.port}`]);
    await expect.poll(() => server.sockets.size + gateway.sockets.size).toBe(0);
  });

  it('defaults to direct and closes HTTP errors, invalid JSON, oversized and unread response bodies', async () => {
    const server = await listen(createServer((request, response) => {
      if (request.url === '/redirect') { response.writeHead(302, { location: '/ok' }); response.write('unread'); return; }
      if (request.url === '/invalid') { response.end('not-json'); return; }
      if (request.url === '/large') { response.writeHead(200); response.write('a'.repeat(256)); return; }
      response.end('{"ok":true}');
    }));
    const transport = createTransport(execution(64));
    expect(await transport.buildInfo(server.url, new AbortController().signal)).toEqual({ ok: true });
    for (const [path, details] of [['redirect', { status: 302 }], ['invalid', { reason: 'INVALID_JSON' }], ['large', { reason: 'OUTPUT_LIMIT' }]] as const) {
      await expect(transport.buildInfo(`${server.url}/${path}`, new AbortController().signal)).rejects.toMatchObject({ code: 'BUILD_INFO', details });
    }
    await expect.poll(() => server.sockets.size).toBe(0);
  });
});
