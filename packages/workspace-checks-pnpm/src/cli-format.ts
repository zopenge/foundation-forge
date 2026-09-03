import type { WorkspaceCheckDiagnostic } from '@openge/forge-workspace-checks';

export const workspaceChecksCliUsage = 'Usage: forge-workspace-checks [--cwd <path>] [--check package-cycles]... [--help]\n';

export function formatCliError(code: string, subject: string): string {
  return `${code}: ${subject}\n`;
}

export function formatWorkspaceCheckDiagnostic(diagnostic: WorkspaceCheckDiagnostic): string {
  const details = diagnostic.details;
  const cycle = diagnostic.code === 'PACKAGE_DEPENDENCY_CYCLE'
    && isJsonObject(details)
    && Array.isArray(details.cycle)
    ? details.cycle.join(' -> ')
    : JSON.stringify(details);
  return `${diagnostic.checkId} ${diagnostic.code}: ${cycle}\n`;
}

function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
