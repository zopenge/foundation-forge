import type { ProcessControlProvider, ProcessTerminationPolicy } from '@openge/forge-process-control';
export interface NodeCommandRunnerOptions {
  readonly platform: 'win32' | 'posix';
  readonly processControl: ProcessControlProvider;
  readonly terminationPolicy: ProcessTerminationPolicy;
  readonly terminationTimeoutMs: number;
  readonly identityAcquisition: { readonly timeoutMs: number; readonly pollIntervalMs: number };
  readonly now?: () => number;
  readonly setTimeout?: typeof globalThis.setTimeout;
  readonly clearTimeout?: typeof globalThis.clearTimeout;
  readonly setInterval?: typeof globalThis.setInterval;
  readonly clearInterval?: typeof globalThis.clearInterval;
}
