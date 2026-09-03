import { createWorkspaceGraph, sortWorkspacePackages } from '@openge/forge-workspace-graph';

const graph = createWorkspaceGraph([{ name: 'a', relativeDirectory: 'a', dependencies: [] }]);
if (sortWorkspacePackages(graph, { dependencyKinds: ['dependencies'] })[0] !== 'a') {
  throw new Error('workspace graph consumer smoke failed');
}
