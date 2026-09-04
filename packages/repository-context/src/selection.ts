import type { RepositoryContextSelection, RepositoryContextSelectionOptions } from './contracts.js';
import { validateStringList } from './errors.js';
import { validateProfile } from './registry.js';

export function stableUniqueRepositoryContextValues<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

export function buildRepositoryContextSelection(options: RepositoryContextSelectionOptions): RepositoryContextSelection {
  const { profile } = options;
  validateProfile(profile);
  for (const field of ['requiredContextFiles', 'localContextFiles', 'globalContextFiles', 'sourceFiles', 'symbols'] as const) {
    if (options[field] !== undefined) validateStringList(options[field], field);
  }
  const context = profile.impactScope === 'global' ? options.globalContextFiles : options.localContextFiles;
  return {
    contextFiles: stableUniqueRepositoryContextValues([...(options.requiredContextFiles ?? []), ...(context ?? [])]),
    sourceFiles: stableUniqueRepositoryContextValues(options.sourceFiles ?? []).slice(0, profile.maxSourceFiles),
    symbols: profile.symbolScope === 'none' ? [] : stableUniqueRepositoryContextValues(options.symbols ?? []).slice(0, profile.maxSymbols),
  };
}
