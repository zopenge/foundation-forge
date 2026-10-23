import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import COS from 'cos-nodejs-sdk-v5';
import { activateArtifactRelease, publishArtifactRelease } from '@openge/forge-artifact-publish';
import { createCosArtifactTransport } from '../src/index.js';
import { fixtureCredentials, header, startCosFixture, type CosFixture } from './cos-server.js';

const fixtures: CosFixture[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(fixture => fixture.close())); });

const bytesObject = (key: string, text: string) => ({
  key, bytes: Buffer.from(text), byteLength: Buffer.byteLength(text),
  sha256: createHash('sha256').update(text).digest('hex'), contentType: 'application/octet-stream',
  cacheControl: 'public,max-age=31536000,immutable',
});
const releasePlan = () => ({
  sourceCommit: 'a'.repeat(40), immutablePrefix: 'releases/a/',
  objects: [bytesObject('releases/a/一个 %.bin', 'one'), bytesObject('releases/a/two.bin', 'two')],
  pointer: { ...bytesObject('current.json', '{"release":"a"}'), contentType: 'application/json', cacheControl: 'no-store' },
});
const publicationOptions = {
  concurrency: 2, timeoutMilliseconds: 5_000, closeTimeoutMilliseconds: 500,
  maxObjectBytes: 1_024, maxTotalBytes: 4_096, maxPointerBytes: 256,
  concurrencyControl: { mode: 'external-serialization' as const, scope: 'fixture-ci' },
};
const config = (fixture: CosFixture) => ({
  bucket: 'fixture-1250000000', region: 'ap-guangzhou', credentials: fixtureCredentials, endpoint: fixture.url,
});
async function fixture(versioning?: 'Enabled' | 'Suspended') {
  const value = await startCosFixture(versioning ? { versioning } : {});
  fixtures.push(value);
  return value;
}

describe('Tencent COS artifact transport', () => {
  it('counts synchronous signing time before starting an immutable upload', async () => {
    const server = await fixture();
    const originalSign = COS.getAuthorization;
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const signing = vi.spyOn(COS, 'getAuthorization').mockImplementation(options => {
      const authorization = originalSign(options);
      if (options.Method === 'PUT') clock.mockReturnValue(5_001);
      return authorization;
    });
    try {
      await expect(publishArtifactRelease(createCosArtifactTransport(config(server)), releasePlan(), {
        ...publicationOptions, concurrency: 1, timeoutMilliseconds: 5_000,
      })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED', closure: { status: 'closed', activeRequests: 0 } });
      expect(signing.mock.calls.some(([options]) => options.Method === 'PUT')).toBe(true);
      expect(server.requests.filter(request => request.method === 'PUT')).toHaveLength(0);
      expect(server.objects.size).toBe(0);
    } finally { signing.mockRestore(); clock.mockRestore(); }
    await vi.waitFor(() => { expect(server.activeConnections).toBe(0); });
  });

  it('uses signed real HTTP requests, immutable writes, actual readback, and pointer-last ordering', async () => {
    const server = await fixture();
    const input = releasePlan();
    const receipt = await publishArtifactRelease(createCosArtifactTransport(config(server)), input, publicationOptions);
    expect(receipt).toMatchObject({ outcome: 'succeeded', target: { provider: 'tencent-cos', namespace: 'ap-guangzhou/fixture-1250000000', endpoint: server.url }, closure: { status: 'closed', activeRequests: 0 } });
    expect(server.objects.get('releases/a/一个 %.bin')?.bytes).toEqual(Buffer.from('one'));
    expect(server.objects.get('current.json')?.bytes).toEqual(Buffer.from('{"release":"a"}'));
    const pointerIndex = server.requests.findIndex(request => request.method === 'PUT' && request.key === 'current.json');
    for (const value of input.objects) {
      const write = server.requests.find(request => request.method === 'PUT' && request.key === value.key);
      expect(write && header(write.headers, 'x-cos-forbid-overwrite')).toBe('true');
      expect(pointerIndex).toBeGreaterThan(server.requests.findIndex(request => request.method === 'GET' && request.key === value.key));
    }
    for (const secret of Object.values(fixtureCredentials)) expect(JSON.stringify(receipt)).not.toContain(secret);
    await vi.waitFor(() => { expect(server.activeConnections).toBe(0); });
  });

  it.each(['Enabled', 'Suspended'] as const)('rejects bucket versioning %s before any upload', async versioning => {
    const server = await fixture(versioning);
    await expect(publishArtifactRelease(createCosArtifactTransport(config(server)), releasePlan(), publicationOptions)).rejects.toMatchObject({ code: 'IMMUTABILITY_UNSUPPORTED' });
    expect(server.requests.filter(request => request.method === 'PUT')).toHaveLength(0);
    expect(server.objects.size).toBe(0);
  });

  it('does not overwrite different existing bytes', async () => {
    const server = await fixture();
    server.objects.set('releases/a/一个 %.bin', { bytes: Buffer.from('bad'), contentType: 'application/octet-stream', cacheControl: 'public,max-age=31536000,immutable' });
    await expect(publishArtifactRelease(createCosArtifactTransport(config(server)), releasePlan(), publicationOptions)).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH', receipt: { pointer: { writeState: 'not-attempted' } } });
    expect(server.objects.get('releases/a/一个 %.bin')?.bytes).toEqual(Buffer.from('bad'));
    expect(server.objects.has('current.json')).toBe(false);
  });

  it('does not silently overwrite differing immutable metadata', async () => {
    const server = await fixture();
    server.objects.set('releases/a/一个 %.bin', { bytes: Buffer.from('one'), contentType: 'text/plain', cacheControl: 'public,max-age=31536000,immutable' });
    await expect(publishArtifactRelease(createCosArtifactTransport(config(server)), releasePlan(), publicationOptions)).rejects.toMatchObject({ code: 'METADATA_MISMATCH' });
    expect(server.objects.get('releases/a/一个 %.bin')?.contentType).toBe('text/plain');
    expect(server.objects.has('current.json')).toBe(false);
  });

  it('reuses matching existing objects and activates without uploading immutable objects', async () => {
    const server = await fixture();
    const input = releasePlan();
    await publishArtifactRelease(createCosArtifactTransport(config(server)), input, publicationOptions);
    const reused = await publishArtifactRelease(createCosArtifactTransport(config(server)), input, publicationOptions);
    expect(reused.objects.every(value => value.writeState === 'already-exists')).toBe(true);
    const before = server.requests.length;
    const objects = input.objects.map(({ bytes, ...descriptor }) => { void bytes; return descriptor; });
    await activateArtifactRelease(createCosArtifactTransport(config(server)), { ...input, objects }, publicationOptions);
    expect(server.requests.slice(before).filter(request => request.method === 'PUT').map(request => request.key)).toEqual(['current.json']);
    expect(server.objects.get('releases/a/two.bin')?.bytes).toEqual(Buffer.from('two'));
  });

  it.each([
    '<VersioningConfiguration>',
    '<VersioningConfiguration Status="Enabled"/>',
    '<!DOCTYPE x [<!ENTITY x "Enabled">]><VersioningConfiguration><Status>&x;</Status></VersioningConfiguration>',
  ])('rejects unknown or malformed versioning XML before writes: %s', async body => {
    const server = await fixture();
    server.setHandler((request, response) => {
      if (request.key !== '') return false;
      response.writeHead(200, { 'content-type': 'application/xml' });
      response.end(body);
      return true;
    });
    await expect(publishArtifactRelease(createCosArtifactTransport(config(server)), releasePlan(), publicationOptions)).rejects.toMatchObject({ code: 'INVALID_REMOTE_RESPONSE' });
    expect(server.requests.some(request => request.method === 'PUT')).toBe(false);
  });

  it('reports authentication failures without leaking server text or credentials', async () => {
    const server = await fixture();
    server.setHandler((_request, response) => {
      response.writeHead(403, { 'content-type': 'application/xml' });
      response.end(`<Error><Code>AccessDenied</Code><Message>${fixtureCredentials.secretKey}</Message></Error>`);
      return true;
    });
    const error: unknown = await publishArtifactRelease(createCosArtifactTransport(config(server)), releasePlan(), publicationOptions).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: 'AUTHENTICATION_FAILED', statusCode: 403, receipt: { pointer: { writeState: 'not-attempted' } } });
    for (const secret of Object.values(fixtureCredentials)) expect(`${String(error)}${JSON.stringify(error)}`).not.toContain(secret);
    expect(server.requests).toHaveLength(1);
  });

  it.each([
    { body: 'bad', code: 'INTEGRITY_MISMATCH' },
    { body: 'no', code: 'INTEGRITY_MISMATCH' },
    { body: 'oversized', code: 'RESPONSE_TOO_LARGE' },
  ])('verifies actual response bytes with opaque ETags: $body', async ({ body, code }) => {
    const server = await fixture();
    server.setHandler((request, response) => {
      if (request.method !== 'GET' || request.key !== 'releases/a/一个 %.bin') return false;
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'public,max-age=31536000,immutable', etag: createHash('sha256').update('one').digest('hex') });
      response.write(body.slice(0, 1));
      response.end(body.slice(1));
      return true;
    });
    await expect(publishArtifactRelease(createCosArtifactTransport(config(server)), releasePlan(), publicationOptions)).rejects.toMatchObject({ code });
    expect(server.objects.has('current.json')).toBe(false);
    await vi.waitFor(() => { expect(server.activeConnections).toBe(0); });
  });

  it('does not reinterpret another 409 error as an existing object', async () => {
    const server = await fixture();
    server.setHandler((request, response) => {
      if (request.method !== 'PUT') return false;
      response.writeHead(409, { 'content-type': 'application/xml' });
      response.end('<Error><Code>UploadConflict</Code></Error>');
      return true;
    });
    await expect(publishArtifactRelease(createCosArtifactTransport(config(server)), releasePlan(), publicationOptions)).rejects.toMatchObject({ code: 'OBJECT_CONFLICT' });
    expect(server.objects.size).toBe(0);
  });

  it('keeps a pointer outcome unknown when storage accepts bytes then drops the connection', async () => {
    const server = await fixture();
    server.setHandler((request, response) => {
      if (request.method !== 'PUT' || request.key !== 'current.json') return false;
      server.objects.set(request.key, { bytes: request.body, contentType: header(request.headers, 'content-type'), cacheControl: header(request.headers, 'cache-control') });
      response.destroy();
      return true;
    });
    await expect(publishArtifactRelease(createCosArtifactTransport(config(server)), releasePlan(), publicationOptions)).rejects.toMatchObject({ code: 'TRANSPORT_FAILED', receipt: { pointer: { writeState: 'unknown' } } });
    expect(server.objects.get('current.json')?.bytes).toEqual(Buffer.from('{"release":"a"}'));
    expect(server.requests.filter(request => request.method === 'PUT' && request.key === 'current.json')).toHaveLength(1);
  });

  it('destroys stalled HTTP requests on budget expiry and closes their sockets', async () => {
    const server = await fixture();
    server.setHandler(() => true);
    await expect(publishArtifactRelease(createCosArtifactTransport(config(server)), releasePlan(), { ...publicationOptions, timeoutMilliseconds: 200 })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED', closure: { status: 'closed', activeRequests: 0 } });
    expect(server.requests).toHaveLength(1);
    await vi.waitFor(() => { expect(server.activeConnections).toBe(0); });
  });

  it('does not mask a GET authentication failure with the expected object size limit', async () => {
    const server = await fixture();
    server.setHandler((request, response) => {
      if (request.method !== 'GET' || !request.key) return false;
      response.writeHead(403, { 'content-type': 'application/xml' });
      response.end('<Error><Code>AccessDenied</Code><Message>longer than the object</Message></Error>');
      return true;
    });
    await expect(publishArtifactRelease(createCosArtifactTransport(config(server)), releasePlan(), publicationOptions)).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED', statusCode: 403 });
    expect(server.objects.has('current.json')).toBe(false);
  });

  it('reports a missing rollback object without attempting an upload or pointer write', async () => {
    const server = await fixture();
    const input = releasePlan();
    const objects = input.objects.map(({ bytes, ...descriptor }) => { void bytes; return descriptor; });
    await expect(activateArtifactRelease(createCosArtifactTransport(config(server)), { ...input, objects }, publicationOptions)).rejects.toMatchObject({ code: 'OBJECT_MISSING', statusCode: 404 });
    expect(server.requests.some(request => request.method === 'PUT')).toBe(false);
  });

  it('cancels a real in-flight GET and confirms peer sockets have closed', async () => {
    const server = await fixture();
    server.setHandler(request => request.method === 'GET' && request.key === 'releases/a/一个 %.bin');
    const controller = new AbortController();
    const outcome = publishArtifactRelease(createCosArtifactTransport(config(server)), releasePlan(), { ...publicationOptions, signal: controller.signal })
      .then(value => ({ value }), (error: unknown) => ({ error }));
    try {
      await vi.waitFor(() => { expect(server.requests.some(request => request.method === 'GET' && request.key === 'releases/a/一个 %.bin')).toBe(true); });
      controller.abort('PRIVATE_CANCEL_REASON');
      await expect(outcome).resolves.toMatchObject({ error: { code: 'OPERATION_ABORTED', closure: { status: 'closed', activeRequests: 0 }, receipt: { pointer: { writeState: 'not-attempted' } } } });
      expect(JSON.stringify(await outcome)).not.toContain('PRIVATE_CANCEL_REASON');
      expect(server.objects.has('current.json')).toBe(false);
      await vi.waitFor(() => { expect(server.activeConnections).toBe(0); });
    } finally { controller.abort(); await outcome; }
  });

  it('closes an active transport idempotently and refuses further requests', async () => {
    const server = await fixture();
    server.setHandler(() => true);
    const transport = createCosArtifactTransport(config(server));
    const context = { signal: new AbortController().signal, timeoutMilliseconds: 5_000 };
    const outcome = transport.prepare(context).then(value => ({ value }), (error: unknown) => ({ error }));
    try {
      await vi.waitFor(() => { expect(server.requests).toHaveLength(1); });
      const closures = await Promise.all([transport.close({ timeoutMilliseconds: 500 }), transport.close({ timeoutMilliseconds: 500 })]);
      expect(closures).toEqual([{ status: 'closed', activeRequests: 0 }, { status: 'closed', activeRequests: 0 }]);
      await expect(outcome).resolves.toMatchObject({ error: { code: 'TRANSPORT_CLOSED' } });
      await expect(transport.readObject({ key: 'releases/a/x', maxBytes: 3 }, context)).rejects.toMatchObject({ code: 'TRANSPORT_CLOSED' });
      expect(server.requests).toHaveLength(1);
      await vi.waitFor(() => { expect(server.activeConnections).toBe(0); });
    } finally { await transport.close({ timeoutMilliseconds: 500 }); await outcome; }
  });

  it('does not follow a redirect or forward credentials to its destination', async () => {
    const server = await fixture();
    const destination = await fixture();
    server.setHandler((_request, response) => {
      response.writeHead(302, { location: destination.url, 'content-length': 0 });
      response.end();
      return true;
    });
    await expect(publishArtifactRelease(createCosArtifactTransport(config(server)), releasePlan(), publicationOptions)).rejects.toMatchObject({ code: 'TRANSPORT_FAILED', statusCode: 302 });
    expect(destination.requests).toHaveLength(0);
  });

  it('rejects a truncated object response before switching the pointer', async () => {
    const server = await fixture();
    server.setHandler((request, response) => {
      if (request.method !== 'GET' || !request.key) return false;
      response.writeHead(200, { 'content-length': 3, 'content-type': 'application/octet-stream', 'cache-control': 'public,max-age=31536000,immutable' });
      response.flushHeaders();
      response.write('o');
      response.destroy();
      return true;
    });
    await expect(publishArtifactRelease(createCosArtifactTransport(config(server)), releasePlan(), publicationOptions)).rejects.toMatchObject({ code: 'TRANSPORT_FAILED' });
    expect(server.objects.has('current.json')).toBe(false);
    await vi.waitFor(() => { expect(server.activeConnections).toBe(0); });
  });

  it.each([
    { bucket: '../invalid' }, { region: 'bad..region' },
    { endpoint: 'http://objects.example.test' }, { endpoint: 'https://objects.example.test/path' },
    { endpoint: 'https://user:password@objects.example.test' },
    { endpoint: null },
    { credentials: { secretId: 'bad\nidentity', secretKey: 'fixture' } },
  ])('rejects unsafe explicit provider configuration: %j', change => {
    expect(() => Reflect.apply(createCosArtifactTransport, undefined, [{ bucket: 'fixture-1250000000', region: 'ap-guangzhou', credentials: fixtureCredentials, ...change }])).toThrowError('INVALID_CONFIGURATION');
  });
});
