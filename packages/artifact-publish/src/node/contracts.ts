import type { ArtifactBytes, ArtifactObjectDescriptor, ArtifactPublicationOptions } from '../contracts.js';
import type { ArtifactIdentity } from '../content-identity.js';

export interface ArtifactFileDescriptor extends ArtifactObjectDescriptor {
  readonly path: string;
}

export interface ArtifactFileReleasePlan extends ArtifactIdentity {
  readonly immutablePrefix: string;
  readonly objects: readonly ArtifactFileDescriptor[];
  readonly pointer: ArtifactBytes;
}

export interface ArtifactFilePublicationOptions extends ArtifactPublicationOptions {
  readonly pathCaseSensitivity: 'case-sensitive' | 'case-insensitive';
}
