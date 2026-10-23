import type { ArtifactBytes, ArtifactObjectDescriptor, ArtifactPublicationOptions } from '../contracts.js';

export interface ArtifactFileDescriptor extends ArtifactObjectDescriptor {
  readonly path: string;
}

export interface ArtifactFileReleasePlan {
  readonly sourceCommit: string;
  readonly immutablePrefix: string;
  readonly objects: readonly ArtifactFileDescriptor[];
  readonly pointer: ArtifactBytes;
}

export interface ArtifactFilePublicationOptions extends ArtifactPublicationOptions {
  readonly pathCaseSensitivity: 'case-sensitive' | 'case-insensitive';
}
