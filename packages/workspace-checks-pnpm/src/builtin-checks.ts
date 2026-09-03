import { createPackageCycleCheck, type WorkspaceCheck } from '@openge/forge-workspace-checks';

export type BuiltinWorkspaceChecksResult =
  | { readonly checks: readonly WorkspaceCheck[]; readonly ok: true }
  | { readonly checkId: string; readonly code: 'UNKNOWN_CHECK'; readonly ok: false };

export function selectBuiltinWorkspaceChecks(
  checkIds: readonly string[],
): BuiltinWorkspaceChecksResult {
  const checks: WorkspaceCheck[] = [];
  for (const checkId of checkIds) {
    if (checkId !== 'package-cycles') {
      return { checkId, code: 'UNKNOWN_CHECK', ok: false };
    }
    checks.push(createPackageCycleCheck());
  }
  return { checks, ok: true };
}
