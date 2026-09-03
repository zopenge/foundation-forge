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

export interface WindowsProcessControlOptions {
  readonly listenerBackend: 'netstat' | 'powershell';
  readonly runner?: ProcessCommandRunner;
}

export interface PosixProcessControlOptions {
  readonly listenerBackend: 'lsof';
  readonly runner?: ProcessCommandRunner;
}
