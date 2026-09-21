export type CorpusState = 'frozen' | 'current-verified' | 'stale' | 'unknown';
export type Coverage = 'complete-in-declared-scope' | 'partial' | 'unknown';
export type EvidenceLevel = 'syntax' | 'typechecker' | 'configured-build' | 'document-claim' | 'literal-path' | 'lexical-hint';

export interface SourceRef {
  readonly corpusId: string;
  readonly generationId: string;
  readonly path: string;
  readonly sourceSha256: string;
  readonly normalizedSha256: string | null;
  readonly snapshotId: string | null;
  readonly lineStart: number;
  readonly lineEnd: number;
}

export interface Entity {
  readonly id: string;
  readonly kind: 'file' | 'symbol' | 'document' | 'public-entry';
  readonly name: string;
  readonly owner: string | null;
  readonly signature: string | null;
  readonly source: SourceRef;
  readonly evidenceLevel: EvidenceLevel;
}
export interface Edge {
  readonly from: string;
  readonly to: string | null;
  readonly kind: 'imports' | 're-exports' | 'declares' | 'symbol-reference' | 'includes' | 'configured-target' | 'document-link';
  readonly resolution: 'resolved' | 'ambiguous' | 'unresolved';
  readonly evidence: SourceRef;
  readonly evidenceLevel: EvidenceLevel;
  readonly configurationDigest: string | null;
}

export interface Corpus {
  readonly corpusId: string;
  readonly generationId: string;
  readonly corpusState: CorpusState;
  readonly coverage: Coverage;
  readonly entities: readonly Entity[];
  readonly edges: readonly Edge[];
}

export interface Diagnostic {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface EnvelopeBase {
  readonly schemaVersion: 1;
  readonly status: 'ok' | 'no-match' | 'ambiguous' | 'error';
  readonly corpusId: string;
  readonly generationId: string | null;
  readonly corpusState: CorpusState;
  readonly coverage: Coverage;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
  readonly diagnostics: readonly Diagnostic[];
}

export interface EntityEnvelope extends EnvelopeBase {
  readonly entities: readonly Entity[];
}

export interface EdgeEnvelope extends EnvelopeBase {
  readonly edges: readonly Edge[];
}

export interface SearchRequest {
  readonly by: 'path' | 'symbol' | 'text';
  readonly value: string;
  readonly scope?: readonly string[];
  readonly limit?: number;
  readonly cursor?: string | null;
}

export interface RelationRequest {
  readonly ids: readonly string[];
  readonly direction: 'in' | 'out' | 'both';
  readonly depth: 1 | 2;
}

export type NavigationResult = EntityEnvelope | EdgeEnvelope;
