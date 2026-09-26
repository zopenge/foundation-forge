import type { PolicyDiagnostic } from './contracts.js';

export const policyDiagnostic = (
  code: string,
  severity: PolicyDiagnostic['severity'],
  fieldPath: string,
  policyIds: readonly string[] = [],
  relatedIds: readonly string[] = [],
): PolicyDiagnostic => ({
  code,
  severity,
  policyIds,
  fieldPath,
  relatedIds,
});
