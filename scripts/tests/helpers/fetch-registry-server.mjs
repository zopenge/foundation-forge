import { once } from 'node:events';
import { createServer } from 'node:http';

export const serveFetchRegistry = async (context, requestListener) => {
  const servers = new Set();
  const close = async (server) => {
    server.closeAllConnections();
    await new Promise((resolveClose, reject) => server.close(error => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
      else resolveClose();
    }));
    servers.delete(server);
  };
  context.after(() => Promise.all([...servers].map(close)));

  for (;;) {
    context.signal.throwIfAborted();
    const server = createServer((request, response) => {
      if (request.method === 'HEAD' && request.url === '/_fixture/ready') {
        response.writeHead(204);
        response.end();
        return;
      }
      requestListener(request, response);
    });
    servers.add(server);
    server.listen({ port: 0, host: '127.0.0.1', signal: context.signal });
    await once(server, 'listening', { signal: context.signal });
    const registry = `http://127.0.0.1:${String(server.address().port)}`;
    context.diagnostic(JSON.stringify({ fixture: 'release-registry', registry }));
    try {
      await globalThis.fetch(`${registry}/_fixture/ready`, { method: 'HEAD', signal: context.signal });
    } catch (error) {
      if (!(error instanceof TypeError && error.cause instanceof Error && error.cause.message === 'bad port')) throw error;
      // 保持禁止端口的监听，保证下一次动态分配不会再次选择同一端口。
      continue;
    }
    await Promise.all([...servers].filter(candidate => candidate !== server).map(close));
    return registry;
  }
};
