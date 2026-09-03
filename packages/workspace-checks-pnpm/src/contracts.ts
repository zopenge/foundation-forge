import type { WorkspaceCheck, WorkspaceCheckReport } from '@openge/forge-workspace-checks';

export interface CheckPnpmWorkspaceOptions {
  readonly checks?: readonly WorkspaceCheck[];
  readonly cwd: string;
  readonly workspaceFile?: string;
}

export interface WorkspaceChecksCliOutput {
  stderr(value: string): void;
  stdout(value: string): void;
}

export type CheckPnpmWorkspaceResult = WorkspaceCheckReport;
