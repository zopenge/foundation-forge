import { createPackageCycleCheck, runWorkspaceChecks } from '@openge/forge-workspace-checks';
import { createWorkspaceGraph } from '@openge/forge-workspace-graph';

const graph = createWorkspaceGraph([{ name: 'a', relativeDirectory: 'a', dependencies: [] }]);
if (!runWorkspaceChecks(graph, [createPackageCycleCheck()]).passed) {
  throw new Error('workspace checks consumer smoke failed');
}
