import { ArtifactPublicationError } from '@openge/forge-artifact-publish';

export const cosXmlLimit = 65_536;

export function cosStatusError(statusCode: number): ArtifactPublicationError {
  const code = statusCode === 401 || statusCode === 403 ? 'AUTHENTICATION_FAILED'
    : statusCode === 404 ? 'OBJECT_MISSING'
      : statusCode === 409 ? 'OBJECT_CONFLICT' : 'TRANSPORT_FAILED';
  return new ArtifactPublicationError(code, { statusCode });
}
