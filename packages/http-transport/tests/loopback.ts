import { readFileSync } from 'node:fs';
import { createServer as httpServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { connect, type Socket } from 'node:net';

const fixture = (name: string) => readFileSync(new URL(`../package-consumer/fixtures/${name}`, import.meta.url), 'utf8');
export const ca = fixture('ca.pem');
const tlsOptions = { key: fixture('key.pem'), cert: fixture('cert.pem') };

export async function listen(server: Server) {
  const sockets = new Set<Socket>();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('LOOPBACK_ADDRESS');
  return { port: address.port, sockets, close: async () => {
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    for (const socket of sockets) socket.destroy();
    await closed;
  } };
}

export async function origin(handler: (request: IncomingMessage, response: ServerResponse) => void, secure = false) {
  const server = secure ? httpsServer(tlsOptions, handler) : httpServer(handler);
  const listening = await listen(server);
  return { ...listening, url: `${secure ? 'https' : 'http'}://127.0.0.1:${listening.port}` };
}

export async function proxy(targetPort: number, options: { secure?: boolean; status?: number; authorization?: string; stall?: boolean; stallHost?: string } = {}) {
  const requests: string[] = [], authorizations: (string | undefined)[] = [], upstreams = new Set<Socket>();
  const server = options.secure ? httpsServer(tlsOptions) : httpServer();
  server.on('connect', (request, client, head) => {
    requests.push(request.url ?? '');
    authorizations.push(request.headers['proxy-authorization']);
    client.once('end', () => client.destroy());
    if (options.stall || request.url?.startsWith(`${options.stallHost}:`)) return;
    const status = options.status ?? (options.authorization && request.headers['proxy-authorization'] !== options.authorization ? 407 : 200);
    if (status !== 200) { client.end(`HTTP/1.1 ${status} Failed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`); return; }
    // origin.test 只由代理映射至受控loopback，不查询或修改客户端DNS。
    const upstream = connect({ host: '127.0.0.1', port: targetPort });
    upstreams.add(upstream);
    upstream.once('close', () => upstreams.delete(upstream));
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    client.once('close', () => upstream.destroy());
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
  });
  const listening = await listen(server);
  return { ...listening, requests, authorizations, upstreams,
    url: `${options.secure ? 'https' : 'http'}://127.0.0.1:${listening.port}`,
    close: async () => {
      for (const socket of upstreams) socket.destroy();
      await listening.close();
    },
  };
}
