import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { extractCpp } from '../adapters/cpp.js';
import { extractTypeScript } from '../adapters/typescript.js';
import type { Diagnostic, Edge, Entity } from '../core/contracts.js';
import { validateCorpus } from '../core/validate.js';
import { discoverSourceSnapshot } from './discovery.js';
import { discoverSemanticInputs, repositoryInputDigest } from './semantic-inputs.js';
import type {
  BuildRepositoryCorpusOptions,
  BuildRepositoryCorpusResult,
  StoredRepositoryGeneration,
} from './contracts.js';
import {
  acquireBuildLock,
  publishRepositoryGeneration,
  releaseBuildLock,
} from './store.js';

const sha256 = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex');
const isTypeScriptPath = (path: string): boolean => /\.(?:[cm]?[jt]sx?)$/iu.test(path);
const isCppPath = (path: string): boolean => /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|inl)$/iu.test(path);

export const appendAll = <T>(target: T[], values: readonly T[]): void => {
  for (const value of values) target.push(value);
};

export const buildRepositoryCorpus = async (
  options: BuildRepositoryCorpusOptions,
): Promise<BuildRepositoryCorpusResult> => {
  const before = await discoverSourceSnapshot(options.rootDir, options.scopes, options.languages);
  const semanticBefore = await discoverSemanticInputs({
    rootDir: options.rootDir,
    sourceFiles: before.files,
    ...(options.tsconfigPath === undefined ? {} : { tsconfigPath: options.tsconfigPath }),
  });
  const identity = JSON.stringify({
    schemaVersion: 2,
    corpusId: options.corpusId,
    scopes: [...options.scopes].sort(),
    languages: [...options.languages].sort(),
    files: before.files,
    semanticConfigPath: semanticBefore.semanticConfigPath,
    semanticInputs: semanticBefore.inputs,
    configurationDigest: semanticBefore.configurationDigest,
    extractorVersion: 'repository-context-v2',
    sortingVersion: 'v1',
  });
  const inputDigest = repositoryInputDigest(before.digest, semanticBefore.digest);
  const generationId = `generation-${sha256(identity)}`;
  const lock = await acquireBuildLock(options.indexRoot, inputDigest);
  try {
    const entities: Entity[] = [];
    const edges: Edge[] = [];
    const diagnostics: Diagnostic[] = [];
    const typeScriptFiles = before.files.map((file) => file.path).filter(isTypeScriptPath);
    if (typeScriptFiles.length > 0) {
      if (!options.tsconfigPath) {
        diagnostics.push({ code: 'INVALID_ARGUMENT', details: { field: 'tsconfigPath' } });
      } else {
        const extracted = await extractTypeScript({
          rootDir: options.rootDir,
          tsconfigPath: options.tsconfigPath,
          files: typeScriptFiles,
          corpusId: options.corpusId,
          generationId,
        });
        appendAll(entities, extracted.entities);
        appendAll(edges, extracted.edges);
        appendAll(diagnostics, extracted.diagnostics);
      }
    }
    for (const file of before.files.filter((item) => isCppPath(item.path))) {
      const extracted = extractCpp({
        path: file.path,
        text: await readFile(resolve(options.rootDir, file.path), 'utf8'),
        corpusId: options.corpusId,
        generationId,
      });
      appendAll(entities, extracted.entities);
      appendAll(edges, extracted.edges);
      appendAll(diagnostics, extracted.diagnostics);
    }
    if (before.files.length === 0) diagnostics.push({ code: 'EMPTY_INPUT_SET', details: {} });
    if (diagnostics.length > 0 || entities.length === 0) {
      return {
        status: 'rejected',
        corpus: null,
        diagnostics: diagnostics.length > 0 ? diagnostics : [{ code: 'EMPTY_EXTRACTION', details: {} }],
        generation: null,
      };
    }
    const corpus = {
      corpusId: options.corpusId,
      generationId,
      corpusState: 'current-verified' as const,
      coverage: 'complete-in-declared-scope' as const,
      entities: [...entities].sort((left, right) => left.id.localeCompare(right.id)),
      edges: [...edges].sort((left, right) => `${left.from}|${left.to ?? ''}|${left.kind}`
        .localeCompare(`${right.from}|${right.to ?? ''}|${right.kind}`)),
    };
    const validation = validateCorpus(corpus);
    if (validation.length > 0) return { status: 'rejected', corpus: null, diagnostics: validation, generation: null };
    const after = await discoverSourceSnapshot(options.rootDir, options.scopes, options.languages);
    if (after.digest !== before.digest) {
      return {
        status: 'stale',
        corpus: null,
        diagnostics: [{ code: 'SOURCE_CHANGED', details: { phase: 'build' } }],
        generation: null,
      };
    }
    const semanticAfter = await discoverSemanticInputs({
      rootDir: options.rootDir,
      sourceFiles: after.files,
      ...(options.tsconfigPath === undefined ? {} : { tsconfigPath: options.tsconfigPath }),
    });
    if (semanticAfter.digest !== semanticBefore.digest) {
      return {
        status: 'stale',
        corpus: null,
        diagnostics: [{ code: 'SEMANTIC_INPUT_CHANGED', details: { phase: 'build' } }],
        generation: null,
      };
    }
    const generation: StoredRepositoryGeneration = {
      schemaVersion: 2,
      corpusId: options.corpusId,
      generationId,
      inputDigest,
      scopes: [...options.scopes].sort(),
      languages: [...options.languages].sort(),
      files: before.files,
      semanticConfigPath: semanticBefore.semanticConfigPath,
      semanticInputs: semanticBefore.inputs,
      configurationDigest: semanticBefore.configurationDigest,
      extractorVersion: 'repository-context-v2',
      sortingVersion: 'v1',
      corpus,
    };
    await publishRepositoryGeneration(options.indexRoot, generation, lock);
    return { status: 'ok', corpus, diagnostics: [], generation };
  } finally {
    await releaseBuildLock(lock);
  }
};
