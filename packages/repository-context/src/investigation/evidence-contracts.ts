import type { SourceRef } from '../core/contracts.js';

export type EvidenceUnitKind = 'excerpt' | 'enclosing-symbol' | 'file';

export interface EvidenceUnit {
  readonly id: string;
  readonly candidateId: string;
  readonly rank: number;
  readonly kind: EvidenceUnitKind;
  readonly priority: 'primary' | 'support';
  readonly baseline?: boolean;
  readonly source: SourceRef;
  readonly text: string;
}
