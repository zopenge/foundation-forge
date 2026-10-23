import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { setImmediate } from 'node:timers/promises';
import { URL } from 'node:url';

// 消费验证自己的最小 COS 协议服务；不访问云端、不依赖仓库诊断文件。
export async function startCosFixture() {
  const objects = new Map();
  const requests = [];
  const sockets = new Set();
  let stalledKey;
  let resolveStalled;
  const xml = (response, status, body) => {
    response.writeHead(status, { 'content-type': 'application/xml' });
    response.end(body);
  };
  const handle = async (request, response) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      assert.ok(size <= 65_536);
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    const url = new URL(request.url, 'http://127.0.0.1');
    const key = decodeURIComponent(url.pathname.slice(1));
    requests.push({ method: request.method, key });
    assert.match(request.headers.authorization, /^q-sign-algorithm=sha1&/u);
    assert.equal(request.headers['x-cos-security-token'], 'CONSUMER_TOKEN');
    if (request.method === 'GET' && key === '' && url.searchParams.has('versioning')) {
      xml(response, 200, '<VersioningConfiguration xmlns="http://cos.myqcloud.com/doc/2006-03-01/"/>');
    } else if (request.method === 'PUT') {
      assert.equal(request.headers['content-length'], String(bytes.length));
      assert.equal(request.headers['content-md5'], createHash('md5').update(bytes).digest('base64'));
      if (request.headers['x-cos-forbid-overwrite'] === 'true' && objects.has(key)) {
        xml(response, 409, '<Error><Code>FileAlreadyExists</Code></Error>');
      } else {
        objects.set(key, { bytes, contentType: request.headers['content-type'], cacheControl: request.headers['cache-control'] });
        response.writeHead(200, { 'content-length': 0, etag: '"not-a-sha256"' });
        response.end();
      }
    } else if (request.method === 'GET' && key === stalledKey) {
      resolveStalled();
    } else if (request.method === 'GET' && objects.has(key)) {
      const object = objects.get(key);
      response.writeHead(200, { 'content-type': object.contentType, 'cache-control': object.cacheControl,
        etag: '"not-a-sha256"' });
      // 成功回读也覆盖没有 Content-Length 的分块响应。
      response.write(object.bytes.subarray(0, 1));
      response.end(object.bytes.subarray(1));
    } else xml(response, 404, '<Error><Code>NoSuchKey</Code></Error>');
  };
  const server = createServer((request, response) => {
    handle(request, response).catch(() => { response.destroy(); });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => { sockets.delete(socket); }); });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    endpoint: `http://127.0.0.1:${address.port}`, objects, requests,
    stall(key) { stalledKey = key; return new Promise(resolve => { resolveStalled = resolve; }); },
    async assertDisconnected() {
      const deadline = performance.now() + 2_000;
      while (sockets.size > 0 && performance.now() < deadline) await setImmediate();
      assert.equal(sockets.size, 0);
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve(); }); });
    },
  };
}
