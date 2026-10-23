import { ArtifactPublicationError } from '@openge/forge-artifact-publish';
import type { CosArtifactCredentials, CosArtifactTransportOptions } from './contracts.js';

export interface CosConfiguration {
  readonly bucket: string;
  readonly region: string;
  readonly endpoint: URL;
  readonly credentials: CosArtifactCredentials;
}

function credentialText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 8_192
    && value.trim() === value && [...value].every(character => {
      const code = character.charCodeAt(0);
      return code >= 32 && code <= 126;
    });
}

export function validateCosConfiguration(input: CosArtifactTransportOptions): CosConfiguration {
  if (!input || typeof input.bucket !== 'string' || input.bucket.length > 63
    || !/^[a-z0-9][a-z0-9-]*-[0-9]+$/u.test(input.bucket)
    || typeof input.region !== 'string' || input.region.length > 63 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(input.region)
    || (input.endpoint !== undefined && typeof input.endpoint !== 'string')
    || !input.credentials || !credentialText(input.credentials.secretId)
    || !/^[A-Za-z0-9_-]+$/u.test(input.credentials.secretId) || !credentialText(input.credentials.secretKey)
    || (input.credentials.sessionToken !== undefined && !credentialText(input.credentials.sessionToken))) {
    throw new ArtifactPublicationError('INVALID_CONFIGURATION');
  }
  let endpoint: URL;
  try { endpoint = new URL(input.endpoint ?? `https://${input.bucket}.cos.${input.region}.myqcloud.com`); }
  catch { throw new ArtifactPublicationError('INVALID_CONFIGURATION'); }
  const loopback = endpoint.hostname === '127.0.0.1' || endpoint.hostname === '[::1]';
  if ((endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback))
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
    throw new ArtifactPublicationError('INVALID_CONFIGURATION');
  }
  return {
    bucket: input.bucket, region: input.region, endpoint,
    credentials: {
      secretId: input.credentials.secretId, secretKey: input.credentials.secretKey,
      ...(input.credentials.sessionToken !== undefined ? { sessionToken: input.credentials.sessionToken } : {}),
    },
  };
}
