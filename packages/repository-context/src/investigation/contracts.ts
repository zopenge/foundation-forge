import type { Corpus, Diagnostic, SourceRef } from '../core/contracts.js';
import type { EvidenceUnit } from './evidence-contracts.js';

export type InvestigationRoute = 'investigate' | 'investigate-relations';

export interface ReadRangeText {
  readonly source: SourceRef;
  readonly path: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly text: string;
}

export interface ReadRangesResult {
  readonly schemaVersion: 1;
  readonly status: 'ok';
  readonly corpusId: string;
  readonly generationId: string;
  readonly diagnostics: readonly Diagnostic[];
  readonly texts: readonly ReadRangeText[];
}

export interface InvestigationCandidate {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly path: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly signature?: string;
  readonly evidenceLevel: string;
}

export interface InvestigationRelation {
  readonly from: string;
  readonly to: string | null;
  readonly fromPath: string | null;
  readonly toPath: string | null;
  readonly kind: string;
  readonly resolution: string;
  readonly path: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly evidenceLevel: string;
}

export interface InvestigationEvidence extends ReadRangeText {
  readonly score?: number;
  readonly wholeFile?: boolean;
}

export interface ScopeCoverage {
  readonly covered: readonly string[];
  readonly missing: readonly string[];
}

export interface InvestigationResult {
  readonly status: 'ok' | 'ambiguous' | 'insufficient' | 'error';
  readonly reason?: 'NO_USEFUL_CANDIDATE' | 'REQUESTED_SCOPE_MISSING' | 'INVALID_ARGUMENT';
  readonly candidates: readonly InvestigationCandidate[];
  readonly relations: readonly InvestigationRelation[];
  readonly evidence: readonly InvestigationEvidence[];
  readonly evidenceUnits?: readonly EvidenceUnit[];
  readonly sourceHints: readonly InvestigationEvidence[];
  readonly primaryScopeCoverage: ScopeCoverage;
  readonly truncated?: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

export interface InvestigationRequest {
  readonly query: string;
  readonly scope?: readonly string[];
  readonly evidenceBudget?: Readonly<{ maxBytes: number }>;
}

export interface RepositoryInvestigator {
  investigate(request: InvestigationRequest): Promise<InvestigationResult>;
}

export interface RepositoryInvestigatorOptions {
  readonly corpus: Corpus;
  readonly readRanges: (ranges: readonly SourceRef[]) => Promise<ReadRangesResult>;
  readonly route: InvestigationRoute;
  readonly limits?: Readonly<{
    readonly maxCandidates?: number;
    readonly evidenceLines?: number;
    readonly sourceHintLines?: number;
  }>;
  readonly preferredScopes?: readonly string[];
  readonly promoteRelationEndpoints?: boolean;
  readonly includeEvidence?: boolean;
}
