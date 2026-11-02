import type { ProcessIdentityReader } from '@openge/forge-process-control';

export interface ProcessCommandRequest {
  readonly args: readonly string[];
  readonly command: string;
  readonly signal?: AbortSignal;
}

export interface ProcessCommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export type ProcessCommandRunner = (
  request: ProcessCommandRequest,
) => Promise<ProcessCommandResult>;

export interface ProcessIdentityReaderOptions {
  readonly runner?: ProcessCommandRunner;
}

export interface WindowsProcessControlOptions {
  readonly listenerBackend: 'netstat' | 'powershell';
  readonly runner?: ProcessCommandRunner;
  readonly identityReader?: ProcessIdentityReader;
}

export interface PosixProcessControlOptions {
  readonly listenerBackend: 'lsof';
  readonly runner?: ProcessCommandRunner;
}
