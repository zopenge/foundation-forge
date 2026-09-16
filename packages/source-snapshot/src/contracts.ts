import type { JsonValue } from '@openge/forge-deterministic-json';

export interface SnapshotObject {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
}
export interface SnapshotFile extends SnapshotObject {
  readonly objectPaths: readonly string[];
  readonly details?: JsonValue;
}
export interface SnapshotRepository {
  readonly path: string;
  readonly head: string;
  readonly branch: string | null;
  readonly dirty: boolean;
}
export interface SnapshotManifestInput {
  readonly projectId: string;
  readonly policyVersion: string;
  readonly publishedAt: number;
  readonly repositories: readonly SnapshotRepository[];
  readonly files: readonly SnapshotFile[];
  readonly objects: readonly SnapshotObject[];
}
export interface SnapshotManifest extends SnapshotManifestInput {
  readonly schemaVersion: 1;
  readonly snapshotId: string;
}
export interface SnapshotFileChanges {
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
}
export interface SnapshotPin {
  readonly pinId: string;
  readonly snapshotId: string;
  readonly reasonCode: string;
  readonly createdAt: number;
  readonly expiresAt?: number;
}
export interface SnapshotRetentionInput {
  readonly snapshots: readonly SnapshotManifest[];
  readonly currentSnapshotId: string;
  readonly objectPaths: readonly string[];
  readonly now: number;
  readonly keepCount?: number;
  readonly orphanGraceMs?: number;
  readonly orphanedSince?: Readonly<Record<string, number>>;
  readonly pins?: readonly SnapshotPin[];
}
export interface SnapshotRetentionPlan {
  readonly currentSnapshotId: string;
  readonly retainedSnapshotIds: readonly string[];
  readonly removeSnapshotIds: readonly string[];
  readonly referencedObjectPaths: readonly string[];
  readonly orphanObjectPaths: readonly string[];
  readonly removeObjectPaths: readonly string[];
  readonly nextOrphanedSince: Readonly<Record<string, number>>;
}
export type SourceSnapshotErrorCode =
  | 'INVALID_PROJECT_ID' | 'INVALID_INPUT' | 'DUPLICATE_PATH'
  | 'CASE_COLLISION' | 'DANGLING_OBJECT' | 'PROJECT_MISMATCH'
  | 'CURRENT_SNAPSHOT_MISSING' | 'DUPLICATE_SNAPSHOT' | 'OBJECT_CONFLICT'
  | 'GIT_COMMAND_FAILED' | 'GIT_UNAVAILABLE'
  | 'INVALID_POLICY' | 'INVALID_TEXT_ENCODING' | 'BINARY_CONTENT'
  | 'INVALID_SECRET_RULE' | 'INVALID_GROUP' | 'PACK_OBJECT_TOO_LARGE'
  | 'PACK_BUDGET_EXCEEDED' | 'COVERAGE_INVALID' | 'FILE_NOT_PACKED'
  | 'OBJECT_INTEGRITY_MISMATCH' | 'BUNDLE_MISMATCH' | 'TARGET_NOT_OWNED'
  | 'TARGET_OWNER_MISMATCH' | 'TARGET_PROJECT_MISMATCH' | 'SNAPSHOT_LOCKED'
  | 'SOURCE_TARGET_OVERLAP' | 'OBJECT_IMMUTABLE_MISMATCH' | 'SNAPSHOT_COLLISION'
  | 'PUBLICATION_FAILED' | 'ENTRY_MISSING' | 'SNAPSHOT_MISSING' | 'INVALID_SNAPSHOT_ID'
  | 'SNAPSHOT_ID_MISMATCH' | 'MANAGED_PATH_UNSAFE' | 'OBJECT_MISSING'
  | 'DELETE_NOT_CONFIRMED' | 'GC_STATE_INVALID' | 'SNAPSHOT_STORE_INVALID' | 'MANAGED_STORE_INVALID'
  | 'SOURCE_CHANGED' | 'SOURCE_READ_FAILED'
  | 'TEXT_FORMAT_UNSUPPORTED' | 'TEXT_DETAILS_INVALID' | 'TEXT_INTEGRITY_MISMATCH'
  | 'TEXT_READ_LIMIT_EXCEEDED' | 'OUTPUT_NOT_EMPTY'
  | 'PIN_STATE_INVALID' | 'PIN_STATE_CONFLICT' | 'PIN_TARGET_MISSING' | 'STORE_BUDGET_EXCEEDED' | 'ANALYSIS_SOURCE_MISMATCH';
