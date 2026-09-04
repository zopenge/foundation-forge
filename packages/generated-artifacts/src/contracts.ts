export type GeneratedArtifactContent = string | Uint8Array;
export type GeneratedArtifactComparisonMode = 'exact' | 'normalize-newlines';
export interface GeneratedArtifactDefinition {
  readonly path: string;
  readonly content: GeneratedArtifactContent;
  readonly comparison?: GeneratedArtifactComparisonMode;
}
export interface GeneratedArtifactPlanInput {
  readonly artifacts: readonly GeneratedArtifactDefinition[];
  readonly retiredPaths?: readonly string[];
}
export interface GeneratedArtifactPlan {
  readonly artifacts: readonly GeneratedArtifactDefinition[];
  readonly retiredPaths: readonly string[];
}
export interface GeneratedArtifactSnapshotEntry {
  readonly path: string;
  readonly content: Uint8Array;
}
export interface GeneratedArtifactComparison {
  readonly ok: boolean;
  readonly missing: readonly string[];
  readonly stale: readonly string[];
  readonly retiredPresent: readonly string[];
}
export const generatedArtifactErrorCodes = {
  invalidPath: 'GENERATED_ARTIFACT_INVALID_PATH',
  duplicatePath: 'GENERATED_ARTIFACT_DUPLICATE_PATH',
  caseCollision: 'GENERATED_ARTIFACT_CASE_COLLISION',
  pathConflict: 'GENERATED_ARTIFACT_PATH_CONFLICT',
  expectedRetiredOverlap: 'GENERATED_ARTIFACT_EXPECTED_RETIRED_OVERLAP',
  invalidContent: 'GENERATED_ARTIFACT_INVALID_CONTENT',
  rootNotAbsolute: 'GENERATED_ARTIFACT_ROOT_NOT_ABSOLUTE',
  targetOutsideRoot: 'GENERATED_ARTIFACT_TARGET_OUTSIDE_ROOT',
  symlinkRejected: 'GENERATED_ARTIFACT_SYMLINK_REJECTED',
  targetIsDirectory: 'GENERATED_ARTIFACT_TARGET_IS_DIRECTORY',
  readFailed: 'GENERATED_ARTIFACT_READ_FAILED',
  writeFailed: 'GENERATED_ARTIFACT_WRITE_FAILED',
  removeFailed: 'GENERATED_ARTIFACT_REMOVE_FAILED',
  invalidOptions: 'GENERATED_ARTIFACT_INVALID_OPTIONS',
} as const;
export type GeneratedArtifactErrorCode = typeof generatedArtifactErrorCodes[keyof typeof generatedArtifactErrorCodes];
export interface GeneratedArtifactDiagnostic {
  readonly code: GeneratedArtifactErrorCode;
  readonly path: string;
  readonly details: Readonly<Record<string, unknown>>;
}
