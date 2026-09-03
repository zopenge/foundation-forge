export interface WorkspaceChecksCliArguments {
  readonly checkIds: readonly string[];
  readonly cwd: string;
  readonly help: boolean;
}

export type WorkspaceChecksCliArgumentsResult =
  | { readonly ok: true; readonly value: WorkspaceChecksCliArguments }
  | {
    readonly code: 'MISSING_OPTION_VALUE' | 'UNKNOWN_OPTION';
    readonly ok: false;
    readonly option: string;
  };

export function parseWorkspaceChecksCliArguments(
  argumentsList: readonly string[],
  initialCwd: string,
): WorkspaceChecksCliArgumentsResult {
  const checkIds = new Set<string>();
  let cwd = initialCwd;
  let help = false;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === undefined) {
      break;
    }
    if (argument === '--help') {
      help = true;
      continue;
    }
    if (argument === '--cwd' || argument === '--check') {
      const value = argumentsList[index + 1];
      if (value === undefined || value.startsWith('--')) {
        return { code: 'MISSING_OPTION_VALUE', ok: false, option: argument };
      }
      index += 1;
      if (argument === '--cwd') {
        cwd = value;
      } else {
        checkIds.add(value);
      }
      continue;
    }
    return { code: 'UNKNOWN_OPTION', ok: false, option: argument };
  }
  return {
    ok: true,
    value: { checkIds: checkIds.size === 0 ? ['package-cycles'] : [...checkIds], cwd, help },
  };
}
