import { expect, test } from 'vitest';
import * as api from '../src/index.js';

test.each([[3, 1, 66.67], [100, 150, 0], [0, 4, 0], [100, 0, 100]])('reduction %s -> %s', (baseline, loaded, expected) => {
  expect(api.calculateRepositoryContextReductionPercent(baseline, loaded)).toBe(expected);
});
test.each([-1, NaN, Infinity])('rejects invalid reduction input %s', value => {
  expect(() => api.calculateRepositoryContextReductionPercent(value, 1)).toThrowError(expect.objectContaining({ code: 'INVALID_PERCENTAGE' }));
  expect(() => api.calculateRepositoryContextReductionPercent(1, value)).toThrowError(expect.objectContaining({ code: 'INVALID_PERCENTAGE' }));
});
test('returns all exceeded budgets as structured diagnostics in stable order', () => {
  const policy = { maxSourceFiles: 2, maxSymbols: 1, minimumRepositoryReductionPercent: 95, minimumSubsystemReductionPercent: 60, minimumGlobalAvoidancePercent: 90 };
  const metrics = { sourceFileCount: 3, symbolCount: 2, repositoryReductionPercent: 94, subsystemReductionPercent: 59, globalAvoidancePercent: 89 };
  expect(api.evaluateRepositoryContextBudget({ policy, metrics })).toEqual([
    { code: 'SOURCE_FILE_BUDGET_EXCEEDED', actual: 3, limit: 2 },
    { code: 'SYMBOL_BUDGET_EXCEEDED', actual: 2, limit: 1 },
    { code: 'REPOSITORY_REDUCTION_BELOW_MINIMUM', actual: 94, limit: 95 },
    { code: 'SUBSYSTEM_REDUCTION_BELOW_MINIMUM', actual: 59, limit: 60 },
    { code: 'GLOBAL_AVOIDANCE_BELOW_MINIMUM', actual: 89, limit: 90 },
  ]);
  expect(api.evaluateRepositoryContextBudget({ policy, metrics: { sourceFileCount: 2, symbolCount: 1, repositoryReductionPercent: 95, subsystemReductionPercent: 60, globalAvoidancePercent: 90 } })).toEqual([]);
});
test('rejects invalid and missing configured budget measurements', () => {
  expect(() => api.evaluateRepositoryContextBudget({ policy: { maxSourceFiles: 1, maxSymbols: 0, minimumRepositoryReductionPercent: 101 }, metrics: { sourceFileCount: 0, symbolCount: 0 } })).toThrowError(expect.objectContaining({ code: 'INVALID_PERCENTAGE' }));
  expect(() => api.evaluateRepositoryContextBudget({ policy: { maxSourceFiles: 1, maxSymbols: 0, minimumRepositoryReductionPercent: 90 }, metrics: { sourceFileCount: 0, symbolCount: 0 } })).toThrowError(expect.objectContaining({ code: 'INVALID_PERCENTAGE' }));
});
