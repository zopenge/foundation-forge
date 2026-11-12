import { ArtifactPublicationError } from './errors.js';

export interface ArtifactContentIdentity {
  readonly manifestSha256: string;
}

export interface ArtifactProvenance {
  readonly gitRevision: string;
}

export interface ArtifactIdentity {
  readonly content: ArtifactContentIdentity;
  readonly provenance?: ArtifactProvenance;
}

/** 只冻结来源声明；真实清单、输入字节与追溯真实性由适配器核验。 */
export function snapshotArtifactIdentity(input: ArtifactIdentity): ArtifactIdentity {
  if (!input || 'sourceCommit' in input || !input.content
    || typeof input.content.manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(input.content.manifestSha256)
    || (input.provenance !== undefined && (!input.provenance
      || typeof input.provenance.gitRevision !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(input.provenance.gitRevision)))) {
    throw new ArtifactPublicationError('INVALID_PLAN');
  }
  return Object.freeze({ content: Object.freeze({ manifestSha256: input.content.manifestSha256 }),
    ...(input.provenance === undefined ? {} : { provenance: Object.freeze({ gitRevision: input.provenance.gitRevision }) }) });
}
