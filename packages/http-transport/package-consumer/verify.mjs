import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect } from 'node:net';
import process from 'node:process';
import { URL } from 'node:url';
import { classifyHttpTransportError } from '@openge/forge-http-transport';
import { createNodeHttpTransport } from '@openge/forge-http-transport/node';

const fixture = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const resources = [], clients = [], sockets = new Set();
async function listen(server) {
  server.on('connection', socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket));
  });
  resources.push(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}
const client = options => { const value = createNodeHttpTransport(options); clients.push(value); return value; };
try {
  const originPort = await listen(createHttpsServer({ key: fixture('key.pem'), cert: fixture('cert.pem') }, (request, response) => {
    response.writeHead(request.url === '/unread' ? 200 : 206, { 'x-fixture': 'tarball' });
    response.write('stream-');
    if (request.url !== '/unread') response.end('bytes');
  }));
  const authorities = [];
  const proxy = createHttpServer();
  proxy.on('connect', (request, incoming, head) => {
    authorities.push(request.url);
    const upstream = connect(originPort, '127.0.0.1', () => {
      incoming.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      incoming.pipe(upstream).pipe(incoming);
    });
    sockets.add(upstream); upstream.once('close', () => sockets.delete(upstream));
    upstream.on('error', () => incoming.destroy()); incoming.on('error', () => upstream.destroy());
    incoming.once('close', () => upstream.destroy());
  });
  const proxyPort = await listen(proxy);
  const route = client({ route: 'proxy', environment: { HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` }, tls: { ca: fixture('ca.pem') } });
  assert.deepEqual(route.describeRoute(`https://origin.test:${originPort}`), {
    route: 'proxy', bypassed: false, proxyOrigin: `http://127.0.0.1:${proxyPort}`,
  });
  const response = await route.fetch(new URL(`https://origin.test:${originPort}/bytes`));
  assert.equal(response.status, 206); assert.equal(response.headers.get('x-fixture'), 'tarball');
  assert.equal(await response.clone().text(), 'stream-bytes'); assert.equal(await response.text(), 'stream-bytes');
  assert.deepEqual(authorities, [`origin.test:${originPort}`]);
  const direct = client({ route: 'direct', environment: { HTTPS_PROXY: 'invalid' }, tls: { ca: fixture('ca.pem') } });
  assert.equal(await (await direct.fetch(`https://127.0.0.1:${originPort}`)).text(), 'stream-bytes');
  const unread = await route.fetch(`https://origin.test:${originPort}/unread`);
  await route.close();
  await assert.rejects(unread.text(), error => classifyHttpTransportError(error).category === 'cancelled');
  assert.equal(await (await direct.fetch(`https://127.0.0.1:${originPort}`)).text(), 'stream-bytes');
  await direct.close();
  assert.deepEqual(classifyHttpTransportError({ code: 'CERT_HAS_EXPIRED', message: 'secret' }), { category: 'certificate', retryable: false });
  if (!process.env.PACKAGE_CONSUMER_TYPESCRIPT) throw new Error('CONSUMER_TYPESCRIPT_REQUIRED');
  const types = spawnSync(process.execPath, [process.env.PACKAGE_CONSUMER_TYPESCRIPT, '-p', 'tsconfig.json', '--pretty', 'false'],
    { cwd: import.meta.dirname, encoding: 'utf8', windowsHide: true, shell: false });
  assert.equal(types.status, 0, types.stdout + types.stderr);
} finally {
  await Promise.all(clients.map(value => value.close()));
  for (const socket of sockets) socket.destroy();
  await Promise.all(resources.map(server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
}
