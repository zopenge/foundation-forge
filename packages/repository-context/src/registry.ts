import type { RepositoryContextProfile, RepositoryContextRecipe, RepositoryContextRegistry } from './contracts.js';
import { RepositoryContextError, validateIdentifier, validateLimit, validateStringList } from './errors.js';

export function validateProfile(profile: RepositoryContextProfile): void {
  if (!profile || typeof profile !== 'object') throw new RepositoryContextError('INVALID_REGISTRY', { field: 'profile' });
  validateIdentifier(profile.id, 'profile.id');
  validateLimit(profile.maxSourceFiles, 'profile.maxSourceFiles');
  validateLimit(profile.maxSymbols, 'profile.maxSymbols');
  if (!['local', 'global'].includes(profile.impactScope) || !['none', 'local', 'public', 'all'].includes(profile.symbolScope)) {
    throw new RepositoryContextError('INVALID_REGISTRY', { field: 'profile.scope', id: profile.id });
  }
}

export function createRepositoryContextRegistry(input: { readonly profiles: readonly RepositoryContextProfile[]; readonly recipes: readonly RepositoryContextRecipe[] }): RepositoryContextRegistry {
  if (!input || !Array.isArray(input.profiles) || !Array.isArray(input.recipes)) throw new RepositoryContextError('INVALID_REGISTRY', { field: 'registry' });
  const profiles = new Map<string, RepositoryContextProfile>();
  const recipes = new Map<string, RepositoryContextRecipe>();
  for (const profile of input.profiles) {
    validateProfile(profile);
    if (profiles.has(profile.id)) throw new RepositoryContextError('DUPLICATE_PROFILE_ID', { id: profile.id });
    profiles.set(profile.id, { ...profile });
  }
  for (const recipe of input.recipes) {
    if (!recipe || typeof recipe !== 'object') throw new RepositoryContextError('INVALID_REGISTRY', { field: 'recipe' });
    validateIdentifier(recipe.id, 'recipe.id');
    validateIdentifier(recipe.profileId, 'recipe.profileId');
    if (typeof recipe.description !== 'string') throw new RepositoryContextError('INVALID_REGISTRY', { field: 'recipe.description' });
    if (recipes.has(recipe.id)) throw new RepositoryContextError('DUPLICATE_RECIPE_ID', { id: recipe.id });
    if (!profiles.has(recipe.profileId)) throw new RepositoryContextError('UNKNOWN_PROFILE', { id: recipe.profileId });
    for (const field of ['impactShards', 'keywords', 'sourceFiles', 'subsystemCandidates', 'symbols', 'validationCommands'] as const) validateStringList(recipe[field], field);
    recipes.set(recipe.id, { ...recipe, impactShards: [...recipe.impactShards], keywords: [...recipe.keywords], sourceFiles: [...recipe.sourceFiles], subsystemCandidates: [...recipe.subsystemCandidates], symbols: [...recipe.symbols], validationCommands: [...recipe.validationCommands] });
  }
  return { profiles, recipes };
}
