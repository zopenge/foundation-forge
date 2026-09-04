import type { GeneratedArtifactDiagnostic } from '../contracts.js';
export type GeneratedArtifactPathCaseSensitivity = 'case-sensitive' | 'case-insensitive';
export interface GeneratedArtifactFilesystemOptions {
  readonly pathCaseSensitivity: GeneratedArtifactPathCaseSensitivity;
}
export interface GeneratedArtifactPublicationResult {
  readonly written: readonly string[];
  readonly unchanged: readonly string[];
  readonly removed: readonly string[];
  readonly diagnostics: readonly GeneratedArtifactDiagnostic[];
}
