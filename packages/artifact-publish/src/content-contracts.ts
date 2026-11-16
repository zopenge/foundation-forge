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
