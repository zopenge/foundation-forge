import type { ProcessIdentity } from '@openge/forge-process-control';

export type CommandEnvironment =
  | { readonly mode: 'inherit'; readonly values?: Readonly<Record<string, string | undefined>> }
  | { readonly mode: 'replace'; readonly values: Readonly<Record<string, string>> };
export type CommandOutputPolicy =
  | { readonly mode: 'events' }
  | { readonly mode: 'capture'; readonly maxBytesPerStream: number; readonly overflow: 'truncate' | 'fail' }
  | { readonly mode: 'ignore' };
export interface CommandSpec {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly environment?: CommandEnvironment;
  readonly output?: CommandOutputPolicy;
  readonly timeoutMs?: number;
  readonly heartbeatMs?: number;
  readonly signal?: AbortSignal;
}
export type CommandTerminationReason = 'exit' | 'signal' | 'abort' | 'timeout' | 'output-overflow' | 'start-failure' | 'termination-failure';
export const commandErrorCodes = {
  invalidSpec: 'COMMAND_INVALID_SPEC',
  invalidTimeout: 'COMMAND_INVALID_TIMEOUT',
  invalidHeartbeat: 'COMMAND_INVALID_HEARTBEAT',
  invalidCaptureLimit: 'COMMAND_INVALID_CAPTURE_LIMIT',
  abortedBeforeStart: 'COMMAND_ABORTED_BEFORE_START',
  startFailed: 'COMMAND_START_FAILED',
  identityUnavailable: 'COMMAND_IDENTITY_UNAVAILABLE',
  outputOverflow: 'COMMAND_OUTPUT_OVERFLOW',
  observerFailed: 'COMMAND_OBSERVER_FAILED',
  terminationFailed: 'COMMAND_TERMINATION_FAILED',
} as const;
export type CommandErrorCode = typeof commandErrorCodes[keyof typeof commandErrorCodes];
export interface CommandDiagnostic {
  readonly code: CommandErrorCode;
  readonly details: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}
export interface CommandResult {
  readonly identity: ProcessIdentity | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly terminationReason: CommandTerminationReason;
  readonly stdout?: Uint8Array;
  readonly stderr?: Uint8Array;
  readonly stdoutTruncated?: boolean;
  readonly stderrTruncated?: boolean;
  readonly diagnostics: readonly CommandDiagnostic[];
}
export type CommandEvent =
  | { readonly type: 'spawned'; readonly pid: number }
  | { readonly type: 'identified'; readonly identity: ProcessIdentity }
  | { readonly type: 'stdout'; readonly chunk: Uint8Array }
  | { readonly type: 'stderr'; readonly chunk: Uint8Array }
  | { readonly type: 'heartbeat'; readonly elapsedMs: number }
  | { readonly type: 'termination-requested'; readonly reason: Exclude<CommandTerminationReason, 'exit' | 'signal'> }
  | { readonly type: 'exited'; readonly result: CommandResult };
export interface RunningCommand {
  readonly pid: Promise<number>;
  readonly identity: Promise<ProcessIdentity | null>;
  readonly result: Promise<CommandResult>;
  terminate(reason?: 'abort' | 'timeout'): Promise<void>;
}
export type CommandObserver = (event: CommandEvent) => void;
export interface CommandRunner {
  start(spec: CommandSpec, observer?: CommandObserver): RunningCommand;
  run(spec: CommandSpec, observer?: CommandObserver): Promise<CommandResult>;
}
