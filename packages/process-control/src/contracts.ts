export interface ProcessIdentity {
  readonly command?: string;
  readonly pid: number;
  readonly startToken: string;
}

export interface TcpListener {
  readonly address: string;
  readonly port: number;
  readonly process: ProcessIdentity;
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

export interface ProcessTerminationResult {
  readonly forced: boolean;
  readonly pid: number;
}

export interface ProcessControlProvider {
  listTcpListeners(request?: ListTcpListenersRequest): Promise<readonly TcpListener[]>;
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
