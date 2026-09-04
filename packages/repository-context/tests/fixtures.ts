import type { RepositoryContextProfile, RepositoryContextRecipe } from '../src/contracts.js';
export const profile: RepositoryContextProfile = { id: 'compact', impactScope: 'local', maxSourceFiles: 2, maxSymbols: 1, symbolScope: 'local' };
export const recipe: RepositoryContextRecipe = { id: 'inspect', description: 'Inspect a component', profileId: 'compact', impactShards: ['near'], keywords: ['inspect'], sourceFiles: ['z.ts', 'a.ts'], symbols: ['Z'], subsystemCandidates: ['component'], validationCommands: ['check'] };
