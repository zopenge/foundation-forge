import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import { URL } from 'node:url';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function createClient(endpoint) {
  const active = new Set();
  return {
    async call(route, { method = 'GET', bytes, signal, headers = {} } = {}) {
      return new Promise((accept, reject) => {
        const req = request(new URL(route, endpoint), { method, signal, agent: false,
          headers: { ...headers, ...(bytes ? { 'content-length': bytes.length } : {}) } }, res => {
          const chunks = []; let length = 0;
          res.on('data', chunk => { length += chunk.length; if (length > 131072) req.destroy(Error('fixture response bound')); else chunks.push(chunk); });
          res.on('error', reject);
          res.on('end', () => accept({ status: res.statusCode, bytes: Buffer.concat(chunks) }));
        });
        active.add(req);
        req.once('close', () => active.delete(req));
        req.once('error', reject);
        req.end(bytes);
      });
    },
    async close() {
      // 等待请求的实际 close 事件，不能拿 body end 代替连接关闭。
      await Promise.all([...active].map(req => new Promise(resolve => { req.once('close', resolve); req.destroy(); })));
      return { status: 'closed', activeRequests: active.size };
    },
  };
}

// 自包含协议 fixture：静态部署、OCI blob/manifest、镜像运行部署分别存证。
export async function startMultiFixture() {
  const journals = new Map(), releases = new Map(), blobs = new Map(), sockets = new Set(), faults = [];
  let mutations = 0;
  const server = createServer((req, res) => {
    (async () => {
      const chunks = []; let length = 0;
      for await (const chunk of req) { length += chunk.length; assert.ok(length <= 65536); chunks.push(chunk); }
      const body = Buffer.concat(chunks), route = req.url;
      const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (route.startsWith('/journal/')) {
        const key = route.slice(9);
        if (req.method === 'GET') return json(200, journals.get(key) ?? null);
        const { expectedRevision, next } = JSON.parse(body);
        assert.equal(next.binding.requestId, key);
        if ((journals.get(key)?.revision ?? 0) !== expectedRevision) return json(409, { state: 'conflict' });
        journals.set(key, next); return json(200, { state: 'stored' });
      }
      if (req.method === 'GET' && route.startsWith('/releases/')) return json(200, releases.get(route.slice(10)) ?? null);
      if (req.method === 'GET' && route.startsWith('/v2/fixture/blobs/')) {
        const value = blobs.get(route.slice(18)); res.writeHead(value ? 200 : 404); return res.end(value);
      }
      if (req.method === 'GET' && route.startsWith('/assets/')) {
        const value = releases.get(route.slice(8)); res.writeHead(value ? 200 : 404); return res.end(value?.bytes ? Buffer.from(value.bytes, 'base64') : undefined);
      }
      assert.equal(req.headers.authorization, 'Bearer fixture-only');
      const id = req.headers['x-request-id'], fingerprint = req.headers['x-fingerprint'], manifestSha256 = req.headers['x-content-manifest-sha256'];
      assert.match(id, /^[a-z]+-1$/u); assert.match(fingerprint, /^[a-f0-9]{64}$/u); assert.match(manifestSha256, /^[a-f0-9]{64}$/u);
      const claimed = journals.get(id);
      assert.equal(claimed?.writeState, 'unknown');
      assert.equal(claimed.binding.fingerprint, fingerprint);
      assert.equal(claimed.binding.content.manifestSha256, manifestSha256);
      assert.equal(claimed.schemaVersion, 2);
      const base = { id, fingerprint, content: { manifestSha256 }, namespace: 'synthetic', state: 'succeeded' };
      mutations++;
      if (req.method === 'POST' && route === '/deployments') {
        assert.equal(digest(body), claimed.binding.inputs.find(value => value.name === 'static').sha256);
        releases.set(id, { ...base, kind: 'static', bytes: body.toString('base64') });
        if (req.headers['x-lose-response'] === 'yes') return res.destroy();
        return json(201, { id });
      }
      if (req.method === 'POST' && route === '/v2/fixture/blobs/uploads/') {
        res.writeHead(202, { location: '/v2/fixture/blobs/uploads/u1' }); return res.end();
      }
      if (req.method === 'PUT' && route.startsWith('/v2/fixture/blobs/uploads/u1?digest=sha256:')) {
        const sha = route.split('sha256:')[1]; assert.equal(digest(body), sha);
        blobs.set(sha, body); res.writeHead(201, { 'docker-content-digest': 'sha256:' + sha }); return res.end();
      }
      if (req.method === 'PUT' && route === '/v2/fixture/manifests/release-1') {
        const manifest = JSON.parse(body);
        assert.equal(manifest.schemaVersion, 2);
        assert.equal(manifest.mediaType, 'application/vnd.oci.image.manifest.v1+json');
        for (const descriptor of [manifest.config, ...manifest.layers]) {
          const content = blobs.get(descriptor.digest.slice(7));
          assert.ok(content); assert.equal(content.length, descriptor.size);
        }
        assert.equal(digest(body), claimed.binding.inputs.find(value => value.name === 'manifest').sha256);
        releases.set(id, { ...base, kind: 'image', imageDigest: 'sha256:' + digest(body), bytes: body.toString('base64') });
        res.writeHead(201, { 'docker-content-digest': 'sha256:' + digest(body) }); return res.end();
      }
      if (req.method === 'POST' && route === '/runtime/deployments') {
        const selected = JSON.parse(body);
        assert.equal(releases.get('image-1')?.imageDigest, selected.imageDigest);
        releases.set(id, { ...base, kind: 'runtime', state: 'pending', imageDigest: selected.imageDigest });
        return json(201, { id });
      }
      throw Error('unexpected fixture request');
    })().catch(error => { faults.push(error); if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const endpoint = 'http://127.0.0.1:' + server.address().port;
  return { endpoint, mutations: () => mutations, faults,
    live() { releases.get('runtime-1').state = 'succeeded'; },
    async close() {
      const closed = [...sockets].map(socket => new Promise(resolve => { socket.once('close', resolve); socket.destroy(); }));
      await Promise.all([new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())), ...closed]);
      assert.equal(sockets.size, 0);
    },
  };
}
