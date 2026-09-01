import type { TextIntegrityIssue } from '../contracts.js';
import type { TextIntegrityCliOptions } from './contracts.js';
import {
  scanChangedTextIntegrityFiles,
  scanTextIntegrityPaths,
} from './scan.js';

export const runTextIntegrityCli = async (
  argv: readonly string[] = process.argv.slice(2),
  options: TextIntegrityCliOptions = {},
): Promise<number> => {
  const args = argv.filter((argument) => argument !== '--');
  const usesChangedMode = args.includes('--changed');

  if (usesChangedMode && (args.length !== 1 || args[0] !== '--changed')) {
    throw new Error('TEXT_INTEGRITY_ARGUMENT_CONFLICT');
  }

  const issues = usesChangedMode
    ? await scanChangedTextIntegrityFiles(options)
    : await scanExplicitOrDefaultPaths(args, options);
  return printIssues(issues, options.writeError ?? console.error);
};

const scanExplicitOrDefaultPaths = async (
  paths: readonly string[],
  options: TextIntegrityCliOptions,
): Promise<readonly TextIntegrityIssue[]> => {
  const scanPaths = paths.length > 0 ? paths : options.defaultPaths;
  if (scanPaths === undefined || scanPaths.length === 0) {
    throw new Error('TEXT_INTEGRITY_PATH_REQUIRED');
  }
  return scanTextIntegrityPaths(scanPaths, options);
};

const printIssues = (
  issues: readonly TextIntegrityIssue[],
  writeError: (message: string) => void,
): number => {
  for (const issue of issues) {
    writeError(`${issue.file}:${String(issue.line)}: ${issue.code}: ${issue.preview}`);
  }
  return issues.length === 0 ? 0 : 1;
};
