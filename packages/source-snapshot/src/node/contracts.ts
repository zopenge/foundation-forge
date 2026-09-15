import type { SourceClassificationDecision, SourceSecretFinding, SourceSecretRule, SourceSnapshotBundle, SourceSnapshotPolicyInput, SourceTextPackOptions } from '../content-contracts.js';

export interface SourceInventoryRepository {
  readonly path: string;
  readonly root: string;
  readonly realRoot: string | null;
  readonly initialized: boolean;
  readonly head: string | null;
  readonly branch: string | null;
  readonly parentGitlink: string | null;
  readonly dirty: boolean | null;
  readonly statusCount: number | null;
}
export interface SourceInventoryEntry {
  readonly repositoryPath: string;
  readonly relativePath: string;
  readonly projectPath: string;
  readonly absolutePath: string;
  readonly tracked: boolean;
  readonly untracked: boolean;
  readonly mode: string | null;
  readonly status: string | null;
  readonly exists: boolean;
  readonly size: number;
  readonly type: 'file' | 'directory' | 'link' | 'missing' | 'other';
}
export interface SourceInventoryIssue {
  readonly code: 'SUBMODULE_UNINITIALIZED' | 'SUBMODULE_GITLINK_MISSING' | 'SUBMODULE_HEAD_MISMATCH';
  readonly path: string;
  readonly blocking: true;
  readonly expected?: string;
  readonly actual?: string;
}
export interface SourceInventory {
  readonly version: 1;
  readonly sourceRoot: string;
  readonly repositories: readonly SourceInventoryRepository[];
  readonly entries: readonly SourceInventoryEntry[];
  readonly issues: readonly SourceInventoryIssue[];
  readonly summary: Readonly<{ repositoryCount: number; initializedRepositoryCount: number; candidateCount: number; trackedCount: number; untrackedCount: number; dirtyRepositoryCount: number }>;
}
export interface CollectSourceInventoryOptions { readonly sourceRoot: string; readonly signal?: AbortSignal; }

export type SourceSnapshotPathCaseSensitivity = 'case-sensitive' | 'case-insensitive';
export interface SourceSnapshotStorageLayoutOptions {
  readonly entryFile?: string;
  readonly ownerFile?: string;
  readonly gcFile?: string;
  readonly protectedTopLevelDirectories?: readonly string[];
  readonly pathCaseSensitivity?: SourceSnapshotPathCaseSensitivity;
}
export interface PublishSourceSnapshotOptions extends SourceSnapshotStorageLayoutOptions {
  readonly sourceRoot: string;
  readonly targetRoot: string;
  readonly lockPath: string;
  readonly ownerId: string;
}
export interface VerifyPublishedSourceSnapshotOptions extends SourceSnapshotStorageLayoutOptions {
  readonly targetRoot: string;
  readonly ownerId: string;
  readonly snapshotId?: string;
}
export interface SourceSnapshotPublicationResult {
  readonly status: 'LOCAL_VERIFIED' | 'NO_CHANGES';
  readonly snapshotId: string;
  readonly objectCount: number;
  readonly sourceFileCount: number;
  readonly writtenObjects: number;
  readonly reusedObjects: number;
}
export interface SourceSnapshotVerificationResult {
  readonly status: 'LOCAL_VERIFIED';
  readonly snapshotId: string;
  readonly objectCount: number;
  readonly sourceFileCount: number;
}

export interface InspectSourceSnapshotRetentionOptions extends SourceSnapshotStorageLayoutOptions {
  readonly targetRoot: string;
  readonly ownerId: string;
  readonly now: number;
  readonly keepCount?: number;
  readonly orphanGraceMs?: number;
}
export interface PruneSourceSnapshotsOptions extends InspectSourceSnapshotRetentionOptions {
  readonly lockPath: string;
  readonly dryRun?: boolean;
}
export interface SourceSnapshotRetentionStatus {
  readonly status: 'RETENTION_STATUS';
  readonly currentSnapshotId: string;
  readonly snapshotCount: number;
  readonly retentionSnapshotCount: number;
  readonly retainedSnapshotIds: readonly string[];
  readonly pruneCandidateSnapshotIds: readonly string[];
  readonly objectCount: number;
  readonly currentObjectCount: number;
  readonly referencedObjectCount: number;
  readonly orphanObjectCount: number;
  readonly observedOrphanObjectCount: number;
  readonly unobservedOrphanObjectCount: number;
  readonly eligibleObjectCount: number;
  readonly orphanGraceMs: number;
}
export interface SourceSnapshotPruneResult extends Omit<SourceSnapshotRetentionStatus, 'status'> {
  readonly status: 'PRUNE_PREVIEW' | 'PRUNED';
  readonly removeSnapshotIds: readonly string[];
  readonly removeObjectPaths: readonly string[];
  readonly removedSnapshotIds: readonly string[];
  readonly removedObjectPaths: readonly string[];
}

export interface RepositorySnapshotPlanOptions {
  readonly sourceRoot: string;
  readonly projectId: string;
  readonly policyVersion: string;
  readonly publishedAt: number;
  readonly policy: SourceSnapshotPolicyInput;
  readonly pack: SourceTextPackOptions;
  readonly groupForPath: (path: string, entry: SourceInventoryEntry) => string;
  readonly additionalSecretRules?: readonly SourceSecretRule[];
  readonly signal?: AbortSignal;
}
export interface RepositorySnapshotDecision { readonly path: string; readonly decision: SourceClassificationDecision; }
export interface RepositorySnapshotFreezeFile { readonly path: string; readonly sha256: string; }
export interface RepositorySnapshotFreeze { readonly inventoryFingerprint: string; readonly files: readonly RepositorySnapshotFreezeFile[]; }
export interface RepositorySnapshotPlan {
  readonly status: 'READY' | 'BLOCKED';
  readonly publishAllowed: boolean;
  readonly inventory: SourceInventory;
  readonly decisions: readonly RepositorySnapshotDecision[];
  readonly includedPaths: readonly string[];
  readonly reviewEntries: readonly RepositorySnapshotDecision[];
  readonly secretFindings: readonly SourceSecretFinding[];
  readonly contentIssues: readonly { readonly path: string; readonly code: string }[];
  readonly bundle: SourceSnapshotBundle | null;
  readonly freeze: RepositorySnapshotFreeze;
}
export interface RepositorySnapshotFreezeVerification { readonly ok: boolean; readonly inventoryChanged: boolean; readonly changedPaths: readonly string[]; }
export type ExportRepositorySnapshotOptions = RepositorySnapshotPlanOptions & Omit<PublishSourceSnapshotOptions, 'sourceRoot'>;
export interface RepositorySnapshotBlockedExport { readonly status: 'BLOCKED'; readonly plan: RepositorySnapshotPlan; }
export interface RepositorySnapshotPublishedExport { readonly status: 'LOCAL_VERIFIED' | 'NO_CHANGES'; readonly plan: RepositorySnapshotPlan; readonly publication: SourceSnapshotPublicationResult; }
export type RepositorySnapshotExportResult = RepositorySnapshotBlockedExport | RepositorySnapshotPublishedExport;

export interface SourceSnapshotCliConfig {
  readonly projectId: string;
  readonly policyVersion: string;
  readonly sourceRoot: string;
  readonly targetRoot: string;
  readonly lockPath: string;
  readonly ownerId: string;
  readonly policy: SourceSnapshotPolicyInput;
  readonly pack: SourceTextPackOptions;
  readonly groupForPath: (path: string, entry: SourceInventoryEntry) => string;
  readonly additionalSecretRules?: readonly SourceSecretRule[];
  readonly storage?: SourceSnapshotStorageLayoutOptions;
  readonly retention?: Readonly<{ keepCount?: number; orphanGraceMs?: number }>;
}
export interface SourceSnapshotCliContext {
  readonly cwd?: string;
  readonly now?: () => number;
  readonly stdout?: (value: string) => void;
  readonly stderr?: (value: string) => void;
}
export interface SourceSnapshotCliOutcome {
  readonly exitCode: 0 | 1 | 2;
  readonly result: Readonly<Record<string, unknown>>;
}
