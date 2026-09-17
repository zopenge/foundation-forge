import type { SnapshotReadProfile } from './content-contracts.js';
export type CoverageState = 'full-text' | 'metadata-only' | 'policy-excluded' | 'pending-review'
  | 'unsupported-decoding' | 'capture-failed' | 'lfs-pointer-only' | 'unknown';
export interface CoverageRule {
  readonly ruleId: string; readonly ruleVersion: string; readonly producer: string; readonly configDigest: string;
}
export interface CoverageDecision {
  readonly path: string; readonly state: CoverageState; readonly rule?: CoverageRule;
  readonly visibility?: 'public' | 'redacted'; readonly byteLength?: number | null;
}
export interface CoverageBoundary {
  readonly prefix: string;
  readonly state: 'complete' | 'outside-discovery' | 'policy-excluded' | 'submodule-uninitialized' | 'capture-failed' | 'unknown';
  readonly inventory: 'all-paths' | 'git-listed' | 'unknown'; readonly evidenceSha256?: string;
}
export interface SnapshotCoverageOptions {
  readonly decisions?: readonly CoverageDecision[]; readonly candidateCount?: number;
  readonly boundaries?: readonly CoverageBoundary[]; readonly profile?: SnapshotReadProfile;
  readonly roles?: readonly { readonly path: string; readonly role: string }[];
  readonly requiredPaths?: readonly string[];
  readonly maxEntries?: number; readonly maxBytes?: number; readonly topCount?: number;
}
export interface CoverageEntry {
  readonly path: string; readonly state: CoverageState;
  readonly physical: 'full-text' | 'metadata-only' | 'excluded' | 'blocked' | 'unknown';
  readonly priority: 'preferred' | 'reference' | 'unclassified'; readonly role: string | null;
  readonly rule: CoverageRule | null; readonly sourceByteLength: number | null; readonly sourceSha256: string | null;
}
export interface SnapshotCoverageReport {
  readonly schemaVersion: 1; readonly kind: 'source-snapshot-coverage';
  readonly mode: 'observation-only'; readonly snapshotId: string | null; readonly manifestDigest: string | null;
  readonly bodyVerification: 'not-performed'; readonly profileId: string | null;
  readonly entries: readonly CoverageEntry[]; readonly boundaries: readonly CoverageBoundary[];
  readonly summary: {
    readonly enumeratedCandidates: number | null; readonly reportedEntries: number; readonly redactedCandidates: number;
    readonly fullTextFiles: number; readonly logicalSourceBytes: number; readonly objectContainerBytes: number;
    readonly states: Readonly<Record<CoverageState, number>>; readonly unenumeratedBoundaryCount: number;
    readonly unresolvedProfilePaths: readonly string[]; readonly duplicateProfilePaths: readonly string[];
    readonly largestEntries: readonly { readonly path: string; readonly sourceByteLength: number; readonly state: CoverageState }[];
  };
}
export interface CoverageResolution {
  readonly path: string; readonly state: CoverageState | CoverageBoundary['state'] | 'not-exists';
  readonly fullTextAvailable: boolean; readonly sourceExistence: 'unknown' | 'absent';
  readonly entry?: CoverageEntry;
}
