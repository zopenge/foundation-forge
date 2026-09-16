import type { SnapshotManifest, SnapshotRepository } from './contracts.js';

export type SourcePathType = 'file' | 'directory' | 'link' | 'missing' | 'other';
export interface SourcePathEntry {
  readonly path: string;
  readonly exists: boolean;
  readonly type: SourcePathType;
}
export type SourceClassificationAction = 'include' | 'exclude' | 'review';
export interface SourceClassificationDecision {
  readonly action: SourceClassificationAction;
  readonly ruleId: string;
}
export interface SourceSnapshotPolicyInput {
  readonly sensitiveBasenames?: readonly string[];
  readonly sensitiveBasenamePrefixes?: readonly string[];
  readonly excludedDirectoryNames?: readonly string[];
  readonly excludedPathPrefixes?: readonly string[];
  readonly excludedFileSuffixes?: readonly string[];
  readonly binaryExtensions?: readonly string[];
  readonly textExtensions?: readonly string[];
  readonly textBasenames?: readonly string[];
  readonly textPathPrefixes?: readonly string[];
  readonly extensionDecisions?: Readonly<Record<string, SourceClassificationDecision>>;
}
export interface SourceSnapshotPolicy {
  readonly sensitiveBasenames: readonly string[];
  readonly sensitiveBasenamePrefixes: readonly string[];
  readonly excludedDirectoryNames: readonly string[];
  readonly excludedPathPrefixes: readonly string[];
  readonly excludedFileSuffixes: readonly string[];
  readonly binaryExtensions: readonly string[];
  readonly textExtensions: readonly string[];
  readonly textBasenames: readonly string[];
  readonly textPathPrefixes: readonly string[];
  readonly extensionDecisions: Readonly<Record<string, SourceClassificationDecision>>;
}
export interface DecodedSourceText {
  readonly text: string;
  readonly encoding: 'utf8' | 'utf16le' | 'utf16be';
  readonly bom: 'utf8' | 'utf16le' | 'utf16be' | null;
}
export interface SourceSecretInput { readonly path: string; readonly text: string; }
export interface SourceSecretRule {
  readonly ruleId: string;
  readonly expression: RegExp;
  readonly validate?: (matchedValue: string) => boolean;
}
export interface SourceSecretFinding {
  readonly severity: 'block'; readonly ruleId: string; readonly path: string; readonly line: number; readonly column: number;
}
export interface StageSourceTextFileInput { readonly path: string; readonly group: string; readonly bytes: Uint8Array; }
export interface StagedSourceTextFile {
  readonly path: string;
  readonly group: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly text: string;
  readonly encoding: DecodedSourceText['encoding'];
  readonly bom: DecodedSourceText['bom'];
  readonly lineCount: number;
  readonly normalizedSha256: string;
  readonly normalizedByteLength: number;
  readonly finalNewline: boolean;
}
export type SourceTextFormatVersion = 1 | 2;
export interface SourceTextPackOptions {
  readonly targetObjectBytes: number;
  readonly maxObjectBytes: number;
  readonly maxObjectCount: number;
  readonly maxObjectBytesTotal: number;
  readonly textFormatVersion?: SourceTextFormatVersion;
}
export interface SourceTextSegment {
  readonly objectPath: string;
  readonly objectSha256: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly segmentIndex: number;
  readonly segmentCount: number;
  readonly text: string;
  readonly bodyByteOffset?: number;
  readonly bodyByteLength?: number;
  readonly sourceByteOffset?: number;
}
export interface PackedSourceTextFile extends Omit<StagedSourceTextFile, 'text'> {
  readonly textFormatVersion: SourceTextFormatVersion;
  readonly segments: readonly SourceTextSegment[];
}
export interface PackedSourceTextObject {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly group: string;
  readonly content: string;
}
export interface SourceTextPackageMetrics {
  readonly logicalSourceBytes: number;
  readonly uniqueNormalizedBodyBytes: number;
  readonly objectContainerBytes: number;
}
export interface SourceTextPackage {
  readonly objects: readonly PackedSourceTextObject[];
  readonly files: readonly PackedSourceTextFile[];
  readonly metrics: SourceTextPackageMetrics;
}

export interface SourceTextLocatorV2 {
  readonly objectPath: string;
  readonly objectSha256: string;
  readonly bodyByteOffset: number;
  readonly bodyByteLength: number;
  readonly sourceByteOffset: number;
  readonly segmentIndex: number;
  readonly segmentCount: number;
  readonly startLine: number;
  readonly endLine: number;
}
export interface SourceTextDetailsV2 {
  readonly kind: 'source-text';
  readonly formatVersion: 2;
  readonly normalization: 'decoded-lf-utf8-v1';
  readonly group: string;
  readonly encoding: DecodedSourceText['encoding'];
  readonly bom: DecodedSourceText['bom'];
  readonly lineCount: number;
  readonly normalizedSha256: string;
  readonly normalizedByteLength: number;
  readonly finalNewline: boolean;
  readonly rawReconstruction: 'not-provided';
  readonly segments: readonly SourceTextLocatorV2[];
}
export interface SourceTextDetailsV1 {
  readonly kind: 'source-text';
  readonly formatVersion: 1;
  readonly group: string;
  readonly encoding: DecodedSourceText['encoding'];
  readonly bom: DecodedSourceText['bom'];
  readonly lineCount: number;
  readonly segments: readonly Readonly<Record<string, unknown>>[];
}
export type SourceTextDetails = SourceTextDetailsV1 | SourceTextDetailsV2;

export interface CreateTextSnapshotManifestInput {
  readonly projectId: string;
  readonly policyVersion: string;
  readonly publishedAt: number;
  readonly repositories: readonly SnapshotRepository[];
  readonly textPackage: SourceTextPackage;
}

export interface SourceSnapshotBundle {
  readonly manifest: SnapshotManifest;
  readonly textPackage: SourceTextPackage;
}

export interface SnapshotObjectBytes {
  readonly path: string;
  readonly bytes: Uint8Array;
}
export interface SnapshotReadLimits {
  readonly maxObjectBytes: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}
export interface SnapshotTextReadResult {
  readonly snapshotId: string;
  readonly path: string;
  readonly text: string;
  readonly normalizedSha256: string;
  readonly sourceSha256: string;
  readonly assurance: 'normalized-text-verified';
}

export interface SnapshotReadProfile {
  readonly profileId: string;
  readonly snapshotId: string;
  readonly preferredPaths: readonly string[];
  readonly referencePaths: readonly string[];
}
export type SnapshotRelationKind = 'imports' | 'exports' | 'references';
export type SnapshotRelationResolution = 'resolved' | 'unresolved' | 'external';
export interface SnapshotRelation {
  readonly relationId: string; readonly snapshotId: string; readonly kind: SnapshotRelationKind;
  readonly fromPath: string; readonly toPath?: string; readonly sourceSha256: string;
  readonly resolution: SnapshotRelationResolution; readonly diagnostics?: readonly string[];
}
export interface SnapshotRelationsValidation {
  readonly schemaVersion: 1; readonly snapshotId: string; readonly relationCount: number;
  readonly relations: readonly SnapshotRelation[];
}

export type SnapshotEvidenceKind = 'static' | 'unit' | 'integration' | 'runtime';
export type SnapshotEvidenceStatus = 'passed' | 'failed' | 'blocked' | 'not-run';
export type SnapshotEvidenceJson = null | boolean | number | string | readonly SnapshotEvidenceJson[] | Readonly<{ [key: string]: SnapshotEvidenceJson }>;
export interface SnapshotEvidenceArtifactRef { readonly artifactId: string; readonly sha256: string; readonly byteLength: number; }
export interface SnapshotEvidenceArtifactBytes { readonly artifactId: string; readonly bytes: Uint8Array; }
export interface SnapshotEvidence {
  readonly evidenceId: string; readonly snapshotId: string; readonly producer: string; readonly producerVersion: string;
  readonly kind: SnapshotEvidenceKind; readonly status: SnapshotEvidenceStatus;
  readonly collected: number; readonly passed: number; readonly failed: number; readonly skipped: number;
  readonly environment?: SnapshotEvidenceJson; readonly artifactRefs: readonly SnapshotEvidenceArtifactRef[];
}
export interface SnapshotEvidenceValidation {
  readonly schemaVersion: 1; readonly snapshotId: string; readonly evidenceId: string;
  readonly producer: string; readonly producerVersion: string;
  readonly schemaStatus: 'schema-valid'; readonly sourceStatus: 'source-bound';
  readonly kind: SnapshotEvidenceKind; readonly status: SnapshotEvidenceStatus;
  readonly collected: number; readonly passed: number; readonly failed: number; readonly skipped: number;
  readonly environment?: SnapshotEvidenceJson; readonly artifactCount: number;
  readonly artifacts: readonly SnapshotEvidenceArtifactRef[];
}
