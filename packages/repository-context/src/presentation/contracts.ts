export type InvestigationView = 'locate' | 'evidence' | 'relations';

export interface WireBudget {
  readonly maxBytes: number;
  readonly maxCandidates: number;
  readonly maxRelations: number;
}

export interface SerializedPage {
  readonly stdout: string;
  readonly byteLength: number;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
}

export interface InvestigationPageRequest {
  readonly corpusId: string;
  readonly generationId: string;
  readonly query: string;
  readonly scope: readonly string[];
  readonly view: InvestigationView;
  readonly cursor: string | null;
  readonly budget: WireBudget;
}

export interface ReadRangeRequest {
  readonly path: string;
  readonly lineStart: number;
  readonly lineEnd: number;
}

export interface ReadPageRequest {
  readonly corpusId: string;
  readonly generationId: string;
  readonly ranges: readonly ReadRangeRequest[];
  readonly cursor: string | null;
  readonly budget: WireBudget;
}