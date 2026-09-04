import type { RepositoryContextBudgetDiagnostic, RepositoryContextBudgetMetrics, RepositoryContextBudgetPolicy } from './contracts.js';
import { RepositoryContextError, validateLimit } from './errors.js';

function validateNonnegative(value: number | undefined, field: string, maximum = Infinity): asserts value is number {
  if (value === undefined || !Number.isFinite(value) || value < 0 || value > maximum) throw new RepositoryContextError('INVALID_PERCENTAGE', { field, value });
}

export function calculateRepositoryContextReductionPercent(baseline: number, loaded: number): number {
  validateNonnegative(baseline, 'baseline');
  validateNonnegative(loaded, 'loaded');
  return baseline === 0 ? 0 : Number(Math.max(0, ((baseline - loaded) / baseline) * 100).toFixed(2));
}

export function evaluateRepositoryContextBudget({ policy, metrics }: { readonly policy: RepositoryContextBudgetPolicy; readonly metrics: RepositoryContextBudgetMetrics }): RepositoryContextBudgetDiagnostic[] {
  const diagnostics: RepositoryContextBudgetDiagnostic[] = [];
  validateLimit(policy.maxSourceFiles, 'maxSourceFiles');
  validateLimit(policy.maxSymbols, 'maxSymbols');
  validateLimit(metrics.sourceFileCount, 'sourceFileCount');
  validateLimit(metrics.symbolCount, 'symbolCount');
  if (metrics.sourceFileCount > policy.maxSourceFiles) diagnostics.push({ code: 'SOURCE_FILE_BUDGET_EXCEEDED', actual: metrics.sourceFileCount, limit: policy.maxSourceFiles });
  if (metrics.symbolCount > policy.maxSymbols) diagnostics.push({ code: 'SYMBOL_BUDGET_EXCEEDED', actual: metrics.symbolCount, limit: policy.maxSymbols });
  const thresholds = [
    ['minimumRepositoryReductionPercent', 'repositoryReductionPercent', 'REPOSITORY_REDUCTION_BELOW_MINIMUM'],
    ['minimumSubsystemReductionPercent', 'subsystemReductionPercent', 'SUBSYSTEM_REDUCTION_BELOW_MINIMUM'],
    ['minimumGlobalAvoidancePercent', 'globalAvoidancePercent', 'GLOBAL_AVOIDANCE_BELOW_MINIMUM'],
  ] as const;
  for (const [policyKey, metricKey, code] of thresholds) {
    const limit = policy[policyKey];
    const actual = metrics[metricKey];
    if (actual !== undefined) validateNonnegative(actual, metricKey, 100);
    if (limit === undefined) continue;
    validateNonnegative(limit, policyKey, 100);
    validateNonnegative(actual, metricKey, 100);
    if (actual < limit) diagnostics.push({ code, actual, limit });
  }
  return diagnostics;
}
