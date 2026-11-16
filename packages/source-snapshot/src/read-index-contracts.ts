import type { SnapshotObject } from './contracts.js';
import type { SourceTextLocatorV2 } from './content-contracts.js';

export type SnapshotReadAssurance = 'normalized-text-verified';
export interface SnapshotReadIndexFile {
  readonly path: string;
  readonly sourceSha256: string;
  readonly sourceByteLength: number;
  readonly sourceLineCount: number;
  readonly group: string;
  readonly formatVersion: 2;
  /** 历史格式能力声明；只有 Reader 返回值才证明本次正文验证已经执行。 */
  readonly assurance: SnapshotReadAssurance;
  readonly normalizedSha256: string;
  readonly normalizedByteLength: number;
  readonly objectRequirements: readonly SnapshotObject[];
  readonly locators: readonly SourceTextLocatorV2[];
}
export interface SnapshotReadIndexMetrics {
  readonly sourceLines: number;
  readonly objectBytes: number;
  readonly renderingLines: number;
}
export interface SnapshotReadIndex {
  readonly schemaVersion: 1;
  readonly snapshotId: string;
  readonly fileCount: number;
  readonly metrics: SnapshotReadIndexMetrics;
  readonly files: readonly SnapshotReadIndexFile[];
}
export interface SnapshotReadViewInput {
  readonly viewId: string;
  readonly snapshotId: string;
  readonly paths: readonly string[];
}
export interface SnapshotReadView {
  readonly viewId: string;
  readonly snapshotId: string;
  readonly found: readonly string[];
  readonly missing: readonly string[];
  readonly unsupported: readonly string[];
  readonly files: readonly SnapshotReadIndexFile[];
}
export interface SnapshotReadProfileView {
  readonly profileId: string;
  readonly snapshotId: string;
  readonly duplicatePaths: readonly string[];
  readonly preferred: SnapshotReadView;
  readonly reference: SnapshotReadView;
}
