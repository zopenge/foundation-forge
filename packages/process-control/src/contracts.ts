export interface ProcessIdentity {
  readonly command?: string;
  readonly pid: number;
  readonly startToken: string;
}

export interface ProcessDescriptor extends ProcessIdentity {
  readonly commandLine?: string;
  readonly name?: string;
  readonly parentPid?: number;
}

export interface TcpListener {
  readonly address: string;
  readonly port: number;
  readonly process: ProcessDescriptor;
}

export interface ListProcessesRequest {
  readonly pids?: readonly number[];
  readonly signal?: AbortSignal;
}

export interface SelectTcpListenersOptions {
  readonly ports: readonly number[];
}

export interface ListTcpListenersRequest {
  readonly ports?: readonly number[];
  readonly signal?: AbortSignal;
}

export type ProcessTerminationPolicy =
  | { readonly mode: 'force' }
  | { readonly mode: 'graceful' }
  | {
    readonly gracePeriodMs: number;
    readonly mode: 'graceful-then-force';
    readonly pollIntervalMs: number;
  };

export interface TerminateProcessTreeRequest {
  readonly process: ProcessIdentity;
  readonly policy: ProcessTerminationPolicy;
  readonly signal?: AbortSignal;
}

export interface TerminateProcessRequest {
  readonly process: ProcessIdentity;
  readonly policy: ProcessTerminationPolicy;
  readonly signal?: AbortSignal;
}

export interface ProcessTerminationResult {
  readonly forced: boolean;
  readonly pid: number;
}

export interface ProcessControlProvider {
  listProcesses(request?: ListProcessesRequest): Promise<readonly ProcessDescriptor[]>;
  listTcpListeners(request?: ListTcpListenersRequest): Promise<readonly TcpListener[]>;
  terminateProcess(request: TerminateProcessRequest): Promise<ProcessTerminationResult>;
  terminateProcessTree(request: TerminateProcessTreeRequest): Promise<ProcessTerminationResult>;
}

export const processControlErrorCodes = {
  commandFailed: 'COMMAND_FAILED',
  invalidInput: 'INVALID_INPUT',
  operationAborted: 'OPERATION_ABORTED',
  processIdentityChanged: 'PROCESS_IDENTITY_CHANGED',
  processIdentityUnavailable: 'PROCESS_IDENTITY_UNAVAILABLE',
  unsupportedBackend: 'UNSUPPORTED_BACKEND',
} as const;

export type ProcessControlErrorCode = typeof processControlErrorCodes[
  keyof typeof processControlErrorCodes
];
