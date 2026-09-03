import type { JsonValue } from '@openge/forge-deterministic-json';
import type { WorkspaceDependencyKind, WorkspaceGraph } from '@openge/forge-workspace-graph';

export interface WorkspaceCheckFinding {
  readonly code: string;
  readonly details: JsonValue;
}

export interface WorkspaceCheck {
  readonly id: string;
  run(graph: WorkspaceGraph): readonly WorkspaceCheckFinding[];
}

export interface WorkspaceCheckDiagnostic extends WorkspaceCheckFinding {
  readonly checkId: string;
}

export interface WorkspaceCheckReport {
  readonly diagnostics: readonly WorkspaceCheckDiagnostic[];
  readonly passed: boolean;
}

export interface PackageCycleCheckOptions {
  readonly dependencyKinds?: readonly WorkspaceDependencyKind[];
}

export const workspaceChecksErrorCodes = {
  duplicateCheckId: 'DUPLICATE_CHECK_ID',
  invalidCheckFindingDetails: 'INVALID_CHECK_FINDING_DETAILS',
} as const;

export type WorkspaceChecksErrorCode = typeof workspaceChecksErrorCodes[
  keyof typeof workspaceChecksErrorCodes
];
