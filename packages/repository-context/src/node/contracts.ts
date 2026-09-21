import type { Corpus, Diagnostic } from '../core/contracts.js';

export type RepositoryLanguage = 'typescript' | 'cpp';

export interface GenerationFileRecord {
  readonly path: string;
  readonly sourceSha256: string;
  readonly size: number;
}

export interface StoredRepositoryGeneration {
  readonly schemaVersion: 1;
  readonly corpusId: string;
  readonly generationId: string;
  readonly inputDigest: string;
  readonly scopes: readonly string[];
  readonly languages: readonly RepositoryLanguage[];
  readonly files: readonly GenerationFileRecord[];
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
