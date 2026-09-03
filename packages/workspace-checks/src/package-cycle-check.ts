import {
  findWorkspaceCycles,
  type WorkspaceDependencyKind,
} from '@openge/forge-workspace-graph';

import type { PackageCycleCheckOptions, WorkspaceCheck } from './contracts.js';

const defaultDependencyKinds = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const satisfies readonly WorkspaceDependencyKind[];

export function createPackageCycleCheck(options: PackageCycleCheckOptions = {}): WorkspaceCheck {
  const dependencyKinds = Object.freeze([...(options.dependencyKinds ?? defaultDependencyKinds)]);
  return {
    id: 'package-cycles',
    run(graph) {
      return findWorkspaceCycles(graph, { dependencyKinds }).map((cycle) => ({
        code: 'PACKAGE_DEPENDENCY_CYCLE',
        details: { cycle },
      }));
    },
  };
}
