import {
  createPackageCycleCheck,
  runWorkspaceChecks,
  type WorkspaceCheckReport,
} from '@openge/forge-workspace-checks';
import { readPnpmWorkspace } from '@openge/forge-workspace-pnpm';

import type { CheckPnpmWorkspaceOptions } from './contracts.js';

export async function checkPnpmWorkspace(
  options: CheckPnpmWorkspaceOptions,
): Promise<WorkspaceCheckReport> {
  const graph = await readPnpmWorkspace(options.workspaceFile === undefined
    ? { cwd: options.cwd }
    : { cwd: options.cwd, workspaceFile: options.workspaceFile });
  return runWorkspaceChecks(graph, options.checks ?? [createPackageCycleCheck()]);
}
