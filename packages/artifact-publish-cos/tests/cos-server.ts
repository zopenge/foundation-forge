import { createHash } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import COS from 'cos-nodejs-sdk-v5';

export const fixtureCredentials = {
  secretId: 'FIXTURE_SECRET_ID', secretKey: 'FIXTURE_SECRET_KEY', sessionToken: 'FIXTURE_SESSION_TOKEN',
};

export interface StoredObject { readonly bytes: Buffer; readonly contentType: string; readonly cacheControl: string }
export interface FixtureRequest {
  readonly method: string;
  readonly key: string;
  readonly url: URL;
  readonly body: Buffer;
  readonly headers: IncomingHttpHeaders;
}
export type FixtureHandler = (request: FixtureRequest, response: ServerResponse) => boolean | Promise<boolean>;

export const header = (headers: IncomingHttpHeaders, name: string): string => {
  const value = headers[name];
  return typeof value === 'string' ? value : '';
};

function xml(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { 'content-type': 'application/xml', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

function signatureMatches(request: FixtureRequest): boolean {
  const authorization = header(request.headers, 'authorization');
  const fields = new Map(authorization.split('&').map(part => {
    const index = part.indexOf('=');
    return [part.slice(0, index), part.slice(index + 1)];
  }));
  const keyTime = fields.get('q-key-time');
  if (!keyTime || !/^\d+;\d+$/u.test(keyTime) || header(request.headers, 'x-cos-security-token') !== fixtureCredentials.sessionToken) return false;
  const names = (fields.get('q-header-list') ?? '').split(';');
  if (!names.includes('host')) return false;
  if (request.method !== 'GET' && request.method !== 'PUT') return false;
  const expected = COS.getAuthorization({
    SecretId: fixtureCredentials.secretId, SecretKey: fixtureCredentials.secretKey,
    Method: request.method, Pathname: decodeURIComponent(request.url.pathname),
    Query: Object.fromEntries(request.url.searchParams),
    Headers: Object.fromEntries(names.map(name => [name, header(request.headers, name)])), KeyTime: keyTime,
  });
  return authorization === expected;
}

export async function startCosFixture(options: { readonly versioning?: 'Enabled' | 'Suspended' } = {}) {
  const objects = new Map<string, StoredObject>();
  const requests: FixtureRequest[] = [];
  const sockets = new Set<Socket>();
  let handler: FixtureHandler | undefined;
  const handle = async (incoming: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const value of incoming) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      length += chunk.byteLength;
      if (length > 1_048_576) { incoming.destroy(); return; }
      chunks.push(chunk);
    }
    const url = new URL(incoming.url ?? '/', 'http://127.0.0.1');
    const request: FixtureRequest = {
      method: incoming.method ?? 'GET', url, key: decodeURIComponent(url.pathname.slice(1)),
      body: Buffer.concat(chunks), headers: { ...incoming.headers },
    };
    requests.push(request);
    if (!signatureMatches(request)) { xml(response, 403, '<Error><Code>SignatureDoesNotMatch</Code></Error>'); return; }
    if (handler && await handler(request, response)) return;
    if (request.method === 'GET' && request.key === '' && url.searchParams.has('versioning')) {
      xml(response, 200, `<VersioningConfiguration xmlns="http://cos.myqcloud.com/doc/2006-03-01/">${options.versioning ? `<Status>${options.versioning}</Status>` : ''}</VersioningConfiguration>`);
      return;
    }
    if (request.method === 'PUT') {
      if (header(request.headers, 'content-md5') !== createHash('md5').update(request.body).digest('base64')
        || header(request.headers, 'content-length') !== String(request.body.byteLength)) {
        xml(response, 400, '<Error><Code>BadDigest</Code></Error>'); return;
      }
      if (header(request.headers, 'x-cos-forbid-overwrite') === 'true' && objects.has(request.key)) {
        xml(response, 409, '<Error><Code>FileAlreadyExists</Code></Error>'); return;
      }
      objects.set(request.key, { bytes: Buffer.from(request.body), contentType: header(request.headers, 'content-type'), cacheControl: header(request.headers, 'cache-control') });
      response.writeHead(200, { 'content-length': 0, etag: '"opaque-not-sha256"' });
      response.end();
      return;
    }
    const stored = objects.get(request.key);
    if (request.method === 'GET' && stored) {
      response.writeHead(200, { 'content-length': stored.bytes.byteLength, 'content-type': stored.contentType, 'cache-control': stored.cacheControl, etag: '"opaque-not-sha256"' });
      response.end(stored.bytes);
      return;
    }
    xml(response, 404, '<Error><Code>NoSuchKey</Code></Error>');
  };
  const server = createServer((incoming, response) => {
    void handle(incoming, response).catch(() => {
      if (!response.destroyed && !response.writableEnded) xml(response, 500, '<Error><Code>FixtureFailure</Code></Error>');
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => { sockets.delete(socket); }); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture address unavailable');
  return {
    url: `http://127.0.0.1:${address.port}`, objects, requests,
    get activeConnections() { return sockets.size; },
    setHandler(value: FixtureHandler) { handler = value; },
    async close() {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve(); }); });
    },
  };
}

export type CosFixture = Awaited<ReturnType<typeof startCosFixture>>;
