import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { validateHeaderValue } from 'node:http';
import COS from 'cos-nodejs-sdk-v5';
import { ArtifactPublicationError, type ArtifactRequestContext } from '@openge/forge-artifact-publish';
import { validatePortableRelativePath } from '@openge/forge-path-safety';
import type { CosConfiguration } from './configuration.js';

export interface CosRequest {
  readonly method: 'GET' | 'PUT';
  readonly key?: string;
  readonly versioning?: boolean;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
  readonly maxResponseBytes: number;
}

export function signCosRequest(configuration: CosConfiguration, input: CosRequest, context: ArtifactRequestContext) {
  try {
    if (!(context.signal instanceof AbortSignal) || !Number.isSafeInteger(context.timeoutMilliseconds)
      || context.timeoutMilliseconds <= 0 || context.timeoutMilliseconds > 2_147_483_647
      || !Number.isSafeInteger(input.maxResponseBytes) || input.maxResponseBytes < 0) {
      throw new ArtifactPublicationError('INVALID_CONFIGURATION');
    }
    if (input.key !== undefined) {
      validatePortableRelativePath(input.key);
      if (Buffer.byteLength(input.key) > 1_024) throw new ArtifactPublicationError('INVALID_PLAN');
    }
    const pathname = input.key === undefined ? '/' : `/${input.key}`;
    const encodedPath = pathname.split('/').map(part => encodeURIComponent(part)
      .replace(/[!'()*]/gu, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
    const url = new URL(`${configuration.endpoint.origin}${encodedPath}`);
    const query: Record<string, string> = input.versioning ? { versioning: '' } : {};
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const body = input.body === undefined ? undefined : Buffer.from(input.body);
    const headers: Record<string, string> = {
      host: url.host, ...input.headers,
      ...(configuration.credentials.sessionToken ? { 'x-cos-security-token': configuration.credentials.sessionToken } : {}),
      ...(body ? { 'content-length': String(body.byteLength), 'content-md5': createHash('md5').update(body).digest('base64') } : {}),
    };
    for (const [name, value] of Object.entries(headers)) validateHeaderValue(name, value);
    headers.authorization = COS.getAuthorization({
      SecretId: configuration.credentials.secretId,
      SecretKey: configuration.credentials.secretKey,
      Method: input.method, Pathname: pathname, Query: query, Headers: headers,
      Expires: Math.max(60, Math.ceil(context.timeoutMilliseconds / 1_000) + 30),
    });
    return { url, headers, body };
  } catch (error) {
    if (error instanceof ArtifactPublicationError) throw error;
    throw new ArtifactPublicationError('INVALID_CONFIGURATION');
  }
}
