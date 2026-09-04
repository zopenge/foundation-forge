export type RepositoryContextImpactScope = 'local' | 'global';
export type RepositoryContextSymbolScope = 'none' | 'local' | 'public' | 'all';
export interface RepositoryContextProfile {
  readonly id: string;
  readonly impactScope: RepositoryContextImpactScope;
  readonly maxSourceFiles: number;
  readonly maxSymbols: number;
  readonly symbolScope: RepositoryContextSymbolScope;
}
export interface RepositoryContextRecipe {
  readonly description: string;
  readonly id: string;
  readonly impactShards: readonly string[];
  readonly keywords: readonly string[];
  readonly profileId: string;
  readonly sourceFiles: readonly string[];
  readonly subsystemCandidates: readonly string[];
  readonly symbols: readonly string[];
  readonly validationCommands: readonly string[];
}
export interface RepositoryContextRegistry {
  readonly profiles: ReadonlyMap<string, RepositoryContextProfile>;
  readonly recipes: ReadonlyMap<string, RepositoryContextRecipe>;
}
export interface RepositoryContextImpactNode {
  readonly dependsOn: readonly string[];
  readonly files: readonly string[];
  readonly id: string;
}
export interface RepositoryContextBudgetPolicy {
  readonly maxSourceFiles: number;
  readonly maxSymbols: number;
  readonly minimumGlobalAvoidancePercent?: number;
  readonly minimumRepositoryReductionPercent?: number;
  readonly minimumSubsystemReductionPercent?: number;
}
export interface RepositoryContextBudgetMetrics {
  readonly sourceFileCount: number;
  readonly symbolCount: number;
  readonly globalAvoidancePercent?: number;
  readonly repositoryReductionPercent?: number;
  readonly subsystemReductionPercent?: number;
}
export type RepositoryContextBudgetCode = 'SOURCE_FILE_BUDGET_EXCEEDED' | 'SYMBOL_BUDGET_EXCEEDED' | 'REPOSITORY_REDUCTION_BELOW_MINIMUM' | 'SUBSYSTEM_REDUCTION_BELOW_MINIMUM' | 'GLOBAL_AVOIDANCE_BELOW_MINIMUM';
export interface RepositoryContextBudgetDiagnostic {
  readonly code: RepositoryContextBudgetCode;
  readonly actual: number;
  readonly limit: number;
}
export type RepositoryContextErrorCode = RepositoryContextBudgetCode | 'DUPLICATE_PROFILE_ID' | 'DUPLICATE_RECIPE_ID' | 'UNKNOWN_PROFILE' | 'INVALID_LIMIT' | 'INVALID_PERCENTAGE' | 'DUPLICATE_IMPACT_NODE_ID' | 'UNKNOWN_IMPACT_NODE' | 'INVALID_REGISTRY';
export interface RepositoryContextSelectionOptions {
  readonly profile: RepositoryContextProfile;
  readonly requiredContextFiles?: readonly string[];
  readonly localContextFiles?: readonly string[];
  readonly globalContextFiles?: readonly string[];
  readonly sourceFiles?: readonly string[];
  readonly symbols?: readonly string[];
}
export interface RepositoryContextSelection {
  readonly contextFiles: readonly string[];
  readonly sourceFiles: readonly string[];
  readonly symbols: readonly string[];
}
export interface RepositoryContextOutputComparison {
  readonly ok: boolean;
  readonly missing: readonly string[];
  readonly stale: readonly string[];
  readonly unexpected: readonly string[];
}
