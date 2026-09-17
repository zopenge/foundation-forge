import type { SnapshotRepository } from './contracts.js';
import type { SnapshotCoverageReport } from './snapshot-coverage-contracts.js';
import type { ReadCatalogBundle } from './read-catalog-contracts.js';
/** 来源合同；生产者标识是调用方声明，不是签名或可信来源证明。 */
export interface ProvenanceProducer { readonly id: string; readonly version: string; readonly configDigest?: string }
export interface ProvenanceFileState {
  readonly path: string; readonly sha256: string; readonly tracked: boolean; readonly untracked: boolean;
  readonly staged: boolean; readonly worktreeModified: boolean; readonly indexStatus: string; readonly worktreeStatus: string;
}
export interface ProvenanceCapture {
  readonly snapshotId: string; readonly manifestDigest: string; readonly exporter?: ProvenanceProducer; readonly grouping?: ProvenanceProducer;
  readonly policy: { readonly version: string; readonly effectiveDigest: string };
  readonly groupDecisionsDigest: string; readonly fileStates: readonly ProvenanceFileState[];
  readonly evidence: 'supplied-records' | 'same-operation';
}
export interface ProvenanceOptions {
  readonly capture?: ProvenanceCapture; readonly coverage?: SnapshotCoverageReport; readonly catalog?: ReadCatalogBundle;
  readonly maxEntries?: number; readonly maxBytes?: number;
}
export interface SnapshotProvenance {
  readonly schemaVersion: 1; readonly kind: 'source-snapshot-provenance'; readonly snapshotId: string; readonly manifestDigest: string;
  readonly origin: 'manifest-only' | 'capture-records'; readonly captureMode: 'unknown' | 'working-tree';
  readonly captureEvidence: 'unknown' | 'supplied-records' | 'same-operation'; readonly atomicity: 'unknown' | 'not-guaranteed';
  readonly exporter: ProvenanceProducer | null; readonly grouping: ProvenanceProducer | null;
  readonly policy: ProvenanceCapture['policy'] | null; readonly reproducibility: 'unknown' | 'caller-declared';
  readonly groupDecisionsDigest: string; readonly frozenInputDigest: string | null;
  readonly repositories: readonly SnapshotRepository[]; readonly repositoryEvidence: 'manifest-declaration' | 'capture-records';
  readonly fileStates: readonly ProvenanceFileState[] | null;
  readonly derived: { readonly coverageDigest: string | null; readonly catalogDigest: string | null };
  readonly bodyVerification: 'not-performed';
}
