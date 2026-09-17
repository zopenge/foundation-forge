import type { SnapshotObject } from './contracts.js';
import type { SnapshotReadProfile } from './content-contracts.js';
import type { SnapshotReadIndexFile } from './read-index.js';

/** 阅读目录的中立合同；所有 I/O、认证与发布时机由消费者控制。 */
export interface ReadCatalogOptions {
  readonly maxRootBytes?: number; readonly maxShardBytes?: number;
  readonly maxTotalBytes?: number; readonly maxArtifactCount?: number;
  readonly profile?: SnapshotReadProfile;
}
export interface CatalogLimits {
  readonly maxRootBytes: number; readonly maxShardBytes: number;
  readonly maxTotalBytes: number; readonly maxArtifactCount: number;
}
export interface CatalogArtifact extends SnapshotObject { readonly content: string }
export interface CatalogReference extends SnapshotObject { readonly prefix: string }
export type CatalogRoute = CatalogReference | { readonly prefix: string; readonly children: readonly CatalogReference[] };
export type CatalogScope = 'paths' | 'aliases';
export interface CatalogFile extends Omit<SnapshotReadIndexFile, 'assurance'> {
  readonly verificationCapabilities: readonly string[];
  readonly priority: 'preferred' | 'reference' | 'unclassified';
}
export interface CatalogAlias {
  readonly path: string; readonly objectPath: string; readonly sourceSha256: string;
  readonly normalizedSha256?: string;
}
export interface CatalogEntry { readonly key: string; readonly record: CatalogFile | CatalogAlias }
export interface CatalogNode {
  readonly schemaVersion: 1; readonly kind: 'leaf' | 'branch'; readonly scope: CatalogScope;
  readonly prefix: string; readonly entries?: readonly CatalogEntry[]; readonly children?: readonly CatalogReference[];
}
export interface ReadCatalogBundle {
  readonly root: CatalogArtifact; readonly artifacts: readonly CatalogArtifact[];
  readonly totalBytes: number; readonly options: ReadCatalogOptions;
}
export interface CatalogRoot {
  readonly schemaVersion: 1; readonly kind: 'source-snapshot-read-catalog';
  readonly snapshotId: string; readonly manifestDigest: string; readonly profileDigest: string;
  readonly fileCount: number; readonly objectCount: number; readonly limits: CatalogLimits;
  readonly paths: CatalogRoute; readonly aliases: CatalogRoute;
  readonly routing: 'sha256-prefix-v1';
}
export interface CatalogQuery { readonly kind: 'path' | 'aliases'; readonly path: string; readonly normalizedSha256?: string }
export interface CatalogReadBudget { readonly maxArtifacts?: number; readonly maxBytes?: number }
export type CatalogResolution =
  | { readonly status: 'needs-artifact'; readonly requirement: CatalogReference }
  | { readonly status: 'not-in-snapshot'; readonly sourceExistence: 'unknown'; readonly catalogDigest: string }
  | { readonly status: 'found'; readonly snapshotId: string; readonly catalogDigest: string;
      readonly files: readonly CatalogFile[]; readonly aliases: readonly CatalogAlias[];
      readonly verifiedArtifactCount: number; readonly verifiedBytes: number;
      readonly bodyVerification: 'not-performed' };
