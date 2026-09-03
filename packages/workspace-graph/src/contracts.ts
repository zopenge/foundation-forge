export type WorkspaceDependencyKind =
  | 'dependencies'
  | 'devDependencies'
  | 'optionalDependencies'
  | 'peerDependencies';

export interface WorkspaceDependency {
  readonly kind: WorkspaceDependencyKind;
  readonly name: string;
  readonly specifier: string;
}

export interface WorkspacePackage {
  readonly dependencies: readonly WorkspaceDependency[];
  readonly name: string;
  readonly relativeDirectory: string;
}

export interface WorkspaceGraph {
  readonly diagnostics: readonly WorkspaceGraphDiagnostic[];
  readonly packages: readonly WorkspacePackage[];
}

export interface WorkspaceGraphTraversalOptions {
  readonly dependencyKinds: readonly WorkspaceDependencyKind[];
}

export interface UnresolvedWorkspaceDependencyDiagnostic {
  readonly code: 'UNRESOLVED_WORKSPACE_DEPENDENCY';
  readonly dependencyName: string;
  readonly kind: WorkspaceDependencyKind;
  readonly packageName: string;
  readonly specifier: string;
}

export type WorkspaceGraphDiagnostic = UnresolvedWorkspaceDependencyDiagnostic;

export const workspaceGraphErrorCodes = {
  cycleDetected: 'CYCLE_DETECTED',
  duplicatePackageName: 'DUPLICATE_PACKAGE_NAME',
  invalidTraversalOptions: 'INVALID_TRAVERSAL_OPTIONS',
  unknownPackage: 'UNKNOWN_PACKAGE',
} as const;

export type WorkspaceGraphErrorCode = typeof workspaceGraphErrorCodes[
  keyof typeof workspaceGraphErrorCodes
];
