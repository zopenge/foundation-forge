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
  readonly path: string; readonly group: string; readonly sha256: string; readonly byteLength: number;
  readonly text: string; readonly encoding: DecodedSourceText['encoding']; readonly bom: DecodedSourceText['bom']; readonly lineCount: number;
}
export interface SourceTextPackOptions {
  readonly targetObjectBytes: number; readonly maxObjectBytes: number; readonly maxObjectCount: number; readonly maxObjectBytesTotal: number;
}
export interface SourceTextSegment {
  readonly objectPath: string; readonly objectSha256: string; readonly startLine: number; readonly endLine: number;
  readonly segmentIndex: number; readonly segmentCount: number; readonly text: string;
}
export interface PackedSourceTextFile extends Omit<StagedSourceTextFile, 'text'> { readonly segments: readonly SourceTextSegment[]; }
export interface PackedSourceTextObject { readonly path: string; readonly sha256: string; readonly byteLength: number; readonly group: string; readonly content: string; }
export interface SourceTextPackage { readonly objects: readonly PackedSourceTextObject[]; readonly files: readonly PackedSourceTextFile[]; }

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
