import type { WorkspaceGraph } from '@openge/forge-workspace-graph';
import {
  DeterministicJsonError,
  stringifyDeterministicJson,
} from '@openge/forge-deterministic-json';

import {
  workspaceChecksErrorCodes,
  type WorkspaceCheck,
  type WorkspaceCheckDiagnostic,
  type WorkspaceCheckReport,
} from './contracts.js';
import { WorkspaceChecksError } from './errors.js';

export function runWorkspaceChecks(
  graph: WorkspaceGraph,
  checks: readonly WorkspaceCheck[],
): WorkspaceCheckReport {
  assertUniqueCheckIds(checks);
  const diagnostics: PreparedDiagnostic[] = [];
  for (const check of checks) {
    for (const finding of check.run(graph)) {
      const diagnostic = { checkId: check.id, code: finding.code, details: finding.details };
      diagnostics.push({ diagnostic, sortKey: createDetailsSortKey(diagnostic) });
    }
  }
  const sortedDiagnostics = diagnostics.toSorted(compareDiagnostics);
  return {
    diagnostics: sortedDiagnostics.map(({ diagnostic }) => diagnostic),
    passed: sortedDiagnostics.length === 0,
  };
}

interface PreparedDiagnostic {
  readonly diagnostic: WorkspaceCheckDiagnostic;
  readonly sortKey: string;
}

function assertUniqueCheckIds(checks: readonly WorkspaceCheck[]): void {
  const checkIds = new Set<string>();
  for (const check of checks) {
    if (checkIds.has(check.id)) {
      throw new WorkspaceChecksError(workspaceChecksErrorCodes.duplicateCheckId, { checkId: check.id });
    }
    checkIds.add(check.id);
  }
}

function createDetailsSortKey(diagnostic: WorkspaceCheckDiagnostic): string {
  try {
    return stringifyDeterministicJson(diagnostic.details);
  } catch (error) {
    if (error instanceof DeterministicJsonError) {
      throw new WorkspaceChecksError(workspaceChecksErrorCodes.invalidCheckFindingDetails, {
        checkId: diagnostic.checkId,
        deterministicJsonCode: error.code,
        path: error.path,
      });
    }
    throw error;
  }
}

function compareDiagnostics(left: PreparedDiagnostic, right: PreparedDiagnostic): number {
  return compareStrings(left.diagnostic.checkId, right.diagnostic.checkId)
    || compareStrings(left.diagnostic.code, right.diagnostic.code)
    || compareStrings(left.sortKey, right.sortKey);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
