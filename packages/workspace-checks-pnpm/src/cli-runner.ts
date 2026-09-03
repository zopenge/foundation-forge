import type { WorkspaceChecksCliOutput } from './contracts.js';
import { parseWorkspaceChecksCliArguments } from './cli-arguments.js';
import { selectBuiltinWorkspaceChecks } from './builtin-checks.js';
import {
  formatCliError,
  formatWorkspaceCheckDiagnostic,
  workspaceChecksCliUsage,
} from './cli-format.js';
import { checkPnpmWorkspace } from './check.js';

export async function runWorkspaceChecksCli(
  argumentsList: readonly string[],
  output: WorkspaceChecksCliOutput,
  initialCwd: string,
): Promise<number> {
  const parsed = parseWorkspaceChecksCliArguments(argumentsList, initialCwd);
  if (!parsed.ok) {
    output.stderr(formatCliError(parsed.code, parsed.option));
    return 2;
  }
  if (parsed.value.help) {
    output.stdout(workspaceChecksCliUsage);
    return 0;
  }
  const selectedChecks = selectBuiltinWorkspaceChecks(parsed.value.checkIds);
  if (!selectedChecks.ok) {
    output.stderr(formatCliError(selectedChecks.code, selectedChecks.checkId));
    return 2;
  }
  try {
    const report = await checkPnpmWorkspace({
      checks: selectedChecks.checks,
      cwd: parsed.value.cwd,
    });
    if (report.passed) {
      output.stdout('Workspace checks passed.\n');
      return 0;
    }
    for (const diagnostic of report.diagnostics) {
      output.stderr(formatWorkspaceCheckDiagnostic(diagnostic));
    }
    return 1;
  } catch (error) {
    output.stderr(error instanceof Error ? `${error.message}\n` : 'WORKSPACE_CHECKS_ERROR\n');
    return 2;
  }
}
