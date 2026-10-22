import type { ProcessIdentity, ProcessTerminationPolicy } from './contracts.js';

export interface OwnedProcessLaunchRequest {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly binding: string;
  readonly startupTimeoutMs: number;
  readonly terminationTimeoutMs: number;
}
interface ScopeEvidence {
  readonly scopeId: string;
  readonly binding: string;
  readonly observedAt: string;
}
export type ProcessScopeClosure =
  | (ScopeEvidence & { readonly status: 'closed'; readonly reason: 'normal'; readonly rootIdentity: ProcessIdentity; readonly empty: true })
  | (ScopeEvidence & { readonly status: 'unknown'; readonly reason: 'terminated' | 'descendants-remained' | 'provider-failed' | 'owner-lost'; readonly rootIdentity?: ProcessIdentity; readonly empty?: boolean });
export interface OwnedProcessCompletion {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly closure: ProcessScopeClosure;
}
export interface OwnedProcessOutput { readonly stream: 'stdout' | 'stderr'; readonly chunk: Uint8Array }
export interface OwnedProcessScope {
  readonly scopeId: string;
  readonly rootPid: Promise<number>;
  readonly completion: Promise<OwnedProcessCompletion>;
  bind(identity: ProcessIdentity, signal?: AbortSignal): Promise<void>;
  authorize(signal?: AbortSignal): Promise<void>;
  terminate(policy: ProcessTerminationPolicy, signal?: AbortSignal): Promise<ProcessScopeClosure>;
  dispose(): Promise<void>;
}
export interface OwnedProcessScopeProvider {
  start(request: OwnedProcessLaunchRequest, output?: (event: OwnedProcessOutput) => void): OwnedProcessScope;
}
