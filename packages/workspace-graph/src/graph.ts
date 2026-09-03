import type {
  WorkspaceDependencyKind,
  WorkspaceGraph,
  WorkspaceGraphDiagnostic,
  WorkspaceGraphTraversalOptions,
  WorkspacePackage,
} from './contracts.js';
import { workspaceGraphErrorCodes } from './contracts.js';
import { WorkspaceGraphError } from './errors.js';

export function createWorkspaceGraph(packages: readonly WorkspacePackage[]): WorkspaceGraph {
  const sortedPackages = [...packages]
    .map((workspacePackage) => ({
      ...workspacePackage,
      dependencies: [...workspacePackage.dependencies].toSorted(compareDependencies),
    }))
    .toSorted((left, right) => compareStrings(left.name, right.name));
  const packageNames = new Set<string>();
  for (const workspacePackage of sortedPackages) {
    if (packageNames.has(workspacePackage.name)) {
      throw new WorkspaceGraphError(workspaceGraphErrorCodes.duplicatePackageName, {
        packageName: workspacePackage.name,
      });
    }
    packageNames.add(workspacePackage.name);
  }
  const diagnostics: WorkspaceGraphDiagnostic[] = [];
  for (const workspacePackage of sortedPackages) {
    for (const dependency of workspacePackage.dependencies) {
      if (dependency.specifier.startsWith('workspace:') && !packageNames.has(dependency.name)) {
        diagnostics.push({
          code: 'UNRESOLVED_WORKSPACE_DEPENDENCY',
          dependencyName: dependency.name,
          kind: dependency.kind,
          packageName: workspacePackage.name,
          specifier: dependency.specifier,
        });
      }
    }
  }
  return { diagnostics, packages: sortedPackages };
}

export function sortWorkspacePackages(
  graph: WorkspaceGraph,
  options: WorkspaceGraphTraversalOptions,
): readonly string[] {
  const cycles = findWorkspaceCycles(graph, options);
  if (cycles.length > 0) {
    throw new WorkspaceGraphError(workspaceGraphErrorCodes.cycleDetected, { cycles });
  }
  const packagesByName = packageMap(graph);
  const includedKinds = dependencyKindSet(options);
  const visited = new Set<string>();
  const ordered: string[] = [];

  const visit = (name: string): void => {
    if (visited.has(name)) {
      return;
    }
    visited.add(name);
    const workspacePackage = packagesByName.get(name);
    if (workspacePackage === undefined) {
      return;
    }
    for (const dependency of workspacePackage.dependencies) {
      if (includedKinds.has(dependency.kind) && packagesByName.has(dependency.name)) {
        visit(dependency.name);
      }
    }
    ordered.push(name);
  };

  for (const workspacePackage of graph.packages) {
    visit(workspacePackage.name);
  }
  return ordered;
}

export function findWorkspaceCycles(
  graph: WorkspaceGraph,
  options: WorkspaceGraphTraversalOptions,
): readonly (readonly string[])[] {
  const packagesByName = packageMap(graph);
  const includedKinds = dependencyKindSet(options);
  const state = new Map<string, 'done' | 'visiting'>();
  const stack: string[] = [];
  const cycles = new Map<string, readonly string[]>();

  const visit = (name: string): void => {
    const currentState = state.get(name);
    if (currentState === 'done') {
      return;
    }
    if (currentState === 'visiting') {
      const start = stack.indexOf(name);
      const canonical = canonicalizeCycle([...stack.slice(start), name]);
      cycles.set(canonical.join('\0'), canonical);
      return;
    }
    state.set(name, 'visiting');
    stack.push(name);
    const workspacePackage = packagesByName.get(name);
    if (workspacePackage !== undefined) {
      for (const dependency of workspacePackage.dependencies) {
        if (includedKinds.has(dependency.kind) && packagesByName.has(dependency.name)) {
          visit(dependency.name);
        }
      }
    }
    stack.pop();
    state.set(name, 'done');
  };

  for (const workspacePackage of graph.packages) {
    visit(workspacePackage.name);
  }
  return [...cycles.values()].toSorted(compareStringArrays);
}

export function listReachableWorkspacePackages(
  graph: WorkspaceGraph,
  rootNames: readonly string[],
  options: WorkspaceGraphTraversalOptions,
): readonly string[] {
  const packagesByName = packageMap(graph);
  const includedKinds = dependencyKindSet(options);
  const reachable = new Set<string>();
  const visit = (name: string): void => {
    if (reachable.has(name)) {
      return;
    }
    const workspacePackage = packagesByName.get(name);
    if (workspacePackage === undefined) {
      throw new WorkspaceGraphError(workspaceGraphErrorCodes.unknownPackage, { packageName: name });
    }
    reachable.add(name);
    for (const dependency of workspacePackage.dependencies) {
      if (includedKinds.has(dependency.kind) && packagesByName.has(dependency.name)) {
        visit(dependency.name);
      }
    }
  };
  for (const rootName of [...rootNames].toSorted()) {
    visit(rootName);
  }
  return sortWorkspacePackages(graph, options).filter((name) => reachable.has(name));
}

function compareDependencies(
  left: WorkspacePackage['dependencies'][number],
  right: WorkspacePackage['dependencies'][number],
): number {
  return compareStrings(left.name, right.name)
    || compareStrings(left.kind, right.kind)
    || compareStrings(left.specifier, right.specifier);
}

function canonicalizeCycle(cycle: readonly string[]): readonly string[] {
  const members = cycle.slice(0, -1);
  if (members.length === 0) {
    return cycle;
  }
  const candidates = members.map((_, index) => [
    ...members.slice(index),
    ...members.slice(0, index),
  ]);
  const canonical = candidates.toSorted(compareStringArrays)[0] ?? [];
  return [...canonical, canonical[0] ?? ''];
}

function compareStringArrays(left: readonly string[], right: readonly string[]): number {
  return compareStrings(left.join('\0'), right.join('\0'));
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function dependencyKindSet(options: WorkspaceGraphTraversalOptions): ReadonlySet<WorkspaceDependencyKind> {
  if (options.dependencyKinds.length === 0) {
    throw new WorkspaceGraphError(workspaceGraphErrorCodes.invalidTraversalOptions);
  }
  return new Set(options.dependencyKinds);
}

function packageMap(graph: WorkspaceGraph): ReadonlyMap<string, WorkspacePackage> {
  return new Map(graph.packages.map((workspacePackage) => [workspacePackage.name, workspacePackage]));
}
