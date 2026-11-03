import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { listenForFetch } from '../../../../scripts/ab-eval/fetch-listener.mjs';

/** 仅模拟云协议，不修改固定版本官方 CLI；上传正文保持原始字节。 */
export async function prebuiltCliServer() {
  const requests: { method: string; url: string; body: Buffer; headers: import('node:http').IncomingHttpHeaders }[] = [];
  const sockets = new Set<Socket>(), closed: Promise<void>[] = [];
  const uploads = new Map<string, Buffer>();
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk); size += bytes.length;
        if (size > 2_097_152) throw new Error('FIXTURE_REQUEST_LIMIT'); chunks.push(bytes);
      }
      const url = request.url ?? '/', method = request.method ?? 'GET';
      requests.push({ method, url, body: Buffer.concat(chunks), headers: request.headers });
      const path = new URL(url, 'http://127.0.0.1').pathname;
      let status = 200, value: unknown;
      if (path === '/v2/user') value = { user: { uid: 'fixture_user', username: 'fixture', email: 'fixture@example.invalid' } };
      else if (path === '/v1/teams') value = { teams: [{ id: 'team_fixture', slug: 'fixture', name: 'Fixture' }], pagination: { count: 1, next: null } };
      else if (path === '/teams/team_fixture') value = { id: 'team_fixture', slug: 'fixture', name: 'Fixture' };
      else if (path === '/v9/projects/prj_fixture') value = { id: 'prj_fixture', name: 'fixture', accountId: 'team_fixture', framework: null, nodeVersion: '22.x' };
      else if (path === '/v2/files') {
        const body = Buffer.concat(chunks); uploads.set(createHash('sha1').update(body).digest('hex'), body); value = { uploaded: true };
      } else if (path === '/v13/deployments' && method === 'POST') {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { files: { sha?: string }[] };
        const missing = body.files.flatMap(file => file.sha && !uploads.has(file.sha) ? [file.sha] : []);
        if (missing.length) { status = 400; value = { error: { code: 'missing_files', missing } }; }
        else value = { id: 'dpl_fixture', url: 'fixture.vercel.app', projectId: 'prj_fixture',
          name: 'fixture', readyState: 'QUEUED', target: 'production', createdAt: Date.now() };
      }
      else { status = 404; value = { error: { code: 'fixture_route_unknown', message: `unexpected ${method} ${path}` } }; }
      response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value));
    } catch { response.writeHead(500); response.end('{"error":{"code":"fixture_request_failed"}}'); }
  });
  server.on('connection', socket => {
    sockets.add(socket); closed.push(new Promise<void>(accept => socket.once('close', () => { sockets.delete(socket); accept(); })));
  });
  await listenForFetch(server);
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('FIXTURE_ADDRESS');
  return { origin: `http://127.0.0.1:${address.port}`, port: address.port, requests, uploads,
    dispose: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
      await Promise.all(closed); if (sockets.size) throw new Error('FIXTURE_SOCKETS_OPEN');
    } };
}
