import type { Diagnostic, Edge, Entity } from '../core/contracts.js';

export type AdapterReadiness = 'ready' | 'ready-for-lexical-evidence' | 'rejected';

export interface ExtractionResult {
  readonly readiness: AdapterReadiness;
  readonly entities: readonly Entity[];
  readonly edges: readonly Edge[];
  readonly diagnostics: readonly Diagnostic[];
  readonly configurationDigest: string | null;
}
