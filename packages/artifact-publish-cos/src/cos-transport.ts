import {
  ArtifactPublicationError, type ArtifactBytes, type ArtifactPublicationTransport,
} from '@openge/forge-artifact-publish';
import type { CosArtifactTransportOptions } from './contracts.js';
import { validateCosConfiguration } from './configuration.js';
import { assertNeverVersioned, cosErrorCode } from './cos-xml.js';
import { CosHttpClient, type CosResponse } from './http-client.js';
import { cosStatusError, cosXmlLimit } from './http-status.js';

function requireSuccess(response: CosResponse): void {
  if (response.statusCode === 200) return;
  throw cosStatusError(response.statusCode);
}

function objectHeaders(object: ArtifactBytes): Record<string, string> {
  if (!(object.bytes instanceof Uint8Array) || object.bytes.byteLength !== object.byteLength
    || object.byteLength > 5_000_000_000) throw new ArtifactPublicationError('INVALID_PLAN');
  return { 'content-type': object.contentType, 'cache-control': object.cacheControl };
}

export function createCosArtifactTransport(options: CosArtifactTransportOptions): ArtifactPublicationTransport {
  const configuration = validateCosConfiguration(options);
  const client = new CosHttpClient(configuration);
  let prepared = false;
  const requirePrepared = () => {
    client.assertOpen();
    if (!prepared) throw new ArtifactPublicationError('IMMUTABILITY_UNSUPPORTED');
  };
  return Object.freeze({
    target: Object.freeze({ provider: 'tencent-cos', namespace: `${configuration.region}/${configuration.bucket}`, endpoint: configuration.endpoint.origin }),
    prepare: async context => {
      const response = await client.request({ method: 'GET', versioning: true, maxResponseBytes: cosXmlLimit }, context);
      requireSuccess(response);
      assertNeverVersioned(response.body);
      prepared = true;
    },
    createObject: async (object, context) => {
      requirePrepared();
      const response = await client.request({
        method: 'PUT', key: object.key, body: object.bytes,
        headers: { ...objectHeaders(object), 'x-cos-forbid-overwrite': 'true' }, maxResponseBytes: cosXmlLimit,
      }, context);
      if (response.statusCode === 409 && cosErrorCode(response.body) === 'FileAlreadyExists') return 'exists';
      requireSuccess(response);
      return 'created';
    },
    readObject: async (request, context) => {
      requirePrepared();
      const response = await client.request({ method: 'GET', key: request.key, maxResponseBytes: request.maxBytes }, context);
      requireSuccess(response);
      const contentType = response.headers['content-type'];
      const cacheControl = response.headers['cache-control'];
      if (typeof contentType !== 'string' || typeof cacheControl !== 'string') throw new ArtifactPublicationError('INVALID_REMOTE_RESPONSE');
      return { bytes: response.body, contentType, cacheControl };
    },
    replaceObject: async (object, context) => {
      requirePrepared();
      const response = await client.request({ method: 'PUT', key: object.key, body: object.bytes, headers: objectHeaders(object), maxResponseBytes: cosXmlLimit }, context);
      requireSuccess(response);
    },
    close: async options => client.close(options.timeoutMilliseconds),
  } satisfies ArtifactPublicationTransport);
}
