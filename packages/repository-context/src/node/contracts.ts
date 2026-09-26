import type { Corpus, Diagnostic } from '../core/contracts.js';

export type RepositoryLanguage = 'typescript' | 'cpp';

export interface GenerationFileRecord {
  readonly path: string;
  readonly sourceSha256: string;
  readonly size: number;
}

export type SemanticInputKind = 'tsconfig' | 'package-json' | 'workspace-manifest' | 'lockfile' | 'module-target' | 'missing-module-target';

export interface SemanticInputRecord {
  readonly kind: SemanticInputKind;
  readonly path: string;
  readonly state: 'present' | 'missing';
  readonly sha256: string | null;
  readonly resolvedPath: string | null;
}

export interface StoredRepositoryGeneration {
  readonly schemaVersion: 2;
  readonly corpusId: string;
  readonly generationId: string;
  readonly inputDigest: string;
  readonly scopes: readonly string[];
  readonly languages: readonly RepositoryLanguage[];
  readonly files: readonly GenerationFileRecord[];
  readonly semanticConfigPath: string | null;
  readonly semanticInputs: readonly SemanticInputRecord[];
  readonly configurationDigest: string;
  readonly extractorVersion: string;
  readonly sortingVersion: string;
  readonly corpus: Corpus;
}

export interface BuildRepositoryCorpusOptions {
  readonly rootDir: string;
  readonly indexRoot: string;
  readonly corpusId: string;
  readonly scopes: readonly string[];
  readonly languages: readonly RepositoryLanguage[];
  readonly tsconfigPath?: string;
}

export interface BuildRepositoryCorpusResult {
  readonly status: 'ok' | 'stale' | 'rejected';
  readonly corpus: Corpus | null;
  readonly diagnostics: readonly Diagnostic[];
  readonly generation: StoredRepositoryGeneration | null;
}
