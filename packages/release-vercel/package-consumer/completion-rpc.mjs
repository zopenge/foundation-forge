import { createServer, request } from 'node:http';
import { Buffer } from 'node:buffer';

/** 只在自有 loopback fixture 中代理受控云边界，不访问真实 Vercel。 */
export async function serveCompletionTransport(transport) {
  const server = createServer((incoming, response) => {
    void (async () => {
      if (incoming.method !== 'POST' || incoming.url !== '/') throw new Error('unexpected fixture request');
      const chunks = []; let length = 0;
      for await (const bytes of incoming) {
        length += bytes.length; if (length > 65_536) throw new Error('fixture request limit'); chunks.push(bytes);
      }
      const { operation, args } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!Array.isArray(args) || args.length > 2) throw new Error('fixture arguments');
      const signal = globalThis.AbortSignal.timeout(30_000);
      let value;
      if (operation === 'api') value = await transport.api(args[0], signal);
      else if (operation === 'buildInfo') value = await transport.buildInfo(args[0], signal);
      else if (operation === 'promote' && transport.promote) value = await transport.promote(args[0], signal);
      else if (operation === 'versionRead' && transport.versionAlias) value = await transport.versionAlias.read(args[0], signal);
      else if (operation === 'versionAssign' && transport.versionAlias?.assign) value = await transport.versionAlias.assign(args[0], args[1], signal);
      else throw new Error('unexpected fixture operation');
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ok: true, value: value ?? null }));
    })().catch(error => {
      if (!response.destroyed && !response.writableEnded) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error: { code: typeof error.code === 'string' ? error.code : 'VERCEL_API', details: error.details ?? {} } }));
      }
    });
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture address missing');
  return { endpoint: `http://127.0.0.1:${address.port}/`, close: () => new Promise((accept, reject) => {
    server.close(error => error ? reject(error) : accept()); server.closeIdleConnections();
  }) };
}

/** 不依赖 Fetch 端口策略或全局网络设置；每个请求沿调用方取消并有界读取。 */
export function completionRpc(endpoint, operation, args, signal) {
  return new Promise((accept, reject) => {
    const body = JSON.stringify({ operation, args });
    const child = request(endpoint, { method: 'POST', signal, agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
      const chunks = []; let length = 0;
      response.on('data', bytes => {
        length += bytes.length;
        if (length > 65_536) { child.destroy(new Error('fixture response limit')); return; }
        chunks.push(bytes);
      });
      response.on('error', reject);
      response.on('end', () => { try { accept(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); } });
    });
    child.setTimeout(30_000, () => child.destroy(new Error('fixture request timeout')));
    child.once('error', reject); child.end(body);
  });
}
export function completionRpcTransport(endpoint, createError) {
  const call = async (operation, args, signal) => {
    const result = await completionRpc(endpoint, operation, args, signal);
    if (!result.ok) throw createError(result.error.code, result.error.details);
    return result.value === null ? undefined : result.value;
  };
  return { api: (path, signal) => call('api', [path], signal), buildInfo: (url, signal) => call('buildInfo', [url], signal),
    promote: (id, signal) => call('promote', [id], signal), versionAlias: {
      read: (hostname, signal) => call('versionRead', [hostname], signal),
      assign: (id, hostname, signal) => call('versionAssign', [id, hostname], signal),
    } };
}
