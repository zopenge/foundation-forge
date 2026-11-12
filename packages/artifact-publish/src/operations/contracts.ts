import type { ArtifactPublicationTarget, ArtifactRequestContext, ArtifactTransportClosure } from '../contracts.js';
import type { ArtifactIdentity } from '../content-identity.js';

export type ArtifactOperationCapability = 'artifact-upload' | 'deployment-create' | 'deployment-ready' | 'activation';
export interface ArtifactOperationInput {
  readonly name: string;
  readonly sha256: string;
  readonly byteLength: number;
}
export interface ArtifactOperationIntent extends ArtifactIdentity {
  readonly requestId: string;
  readonly target: ArtifactPublicationTarget;
  readonly capability: ArtifactOperationCapability;
  readonly configurationSha256: string;
  readonly inputs: readonly ArtifactOperationInput[];
}
export interface ArtifactOperationBinding extends ArtifactOperationIntent {
  readonly fingerprint: string;
}
export type ArtifactOperationObservationState = 'absent' | 'pending' | 'succeeded' | 'failed' | 'unknown';
export type ArtifactOperationAcknowledgement =
  | { readonly state: 'accepted'; readonly reference?: string }
  | { readonly state: 'rejected'; readonly code: string };
export interface ArtifactOperationObservation {
  readonly state: ArtifactOperationObservationState;
  readonly fingerprint: string;
  readonly reference?: string;
}
export interface ArtifactOperationRecord {
  readonly schemaVersion: 2;
  readonly revision: number;
  readonly binding: ArtifactOperationBinding;
  readonly writeState: 'unknown' | 'accepted' | 'rejected';
  readonly observation: ArtifactOperationObservationState;
  readonly reference?: string;
  readonly attemptFailure?: string;
}
/** CAS 必须由存储实际保证；该接口本身不提供跨写入方协调。 */
export interface ArtifactOperationJournal {
  load(requestId: string, context: ArtifactRequestContext): Promise<ArtifactOperationRecord | undefined>;
  compareAndSet(request: { readonly expectedRevision: number; readonly next: ArtifactOperationRecord },
    context: ArtifactRequestContext): Promise<'stored' | 'conflict'>;
}
export interface ArtifactOperationObserver {
  readonly target: ArtifactPublicationTarget;
  readonly capability: ArtifactOperationCapability;
  readonly configurationSha256: string;
  observe(binding: ArtifactOperationBinding, reference: string | undefined,
    context: ArtifactRequestContext): Promise<ArtifactOperationObservation>;
  close(options: { readonly timeoutMilliseconds: number }): Promise<ArtifactTransportClosure>;
}
export interface ArtifactOperationTransport extends ArtifactOperationObserver {
  execute(binding: ArtifactOperationBinding, context: ArtifactRequestContext): Promise<ArtifactOperationAcknowledgement>;
}
export interface ArtifactOperationOptions {
  readonly timeoutMilliseconds: number;
  readonly closeTimeoutMilliseconds: number;
  readonly signal?: AbortSignal;
}
export interface ArtifactOperationReceipt {
  readonly outcome: 'succeeded' | 'pending' | 'failed' | 'unknown';
  readonly record: ArtifactOperationRecord;
  readonly journalState: 'confirmed' | 'unknown';
  readonly closure: ArtifactTransportClosure;
}
export type ArtifactOperationErrorCode =
  | 'INVALID_BINDING' | 'INVALID_OPTIONS' | 'INVALID_JOURNAL' | 'INVALID_RESPONSE'
  | 'TARGET_MISMATCH' | 'BINDING_MISMATCH' | 'CAPABILITY_UNSUPPORTED'
  | 'JOURNAL_UNKNOWN' | 'JOURNAL_CONFLICT' | 'RECOVERY_REQUIRED' | 'OPERATION_MISSING'
  | 'PROVIDER_FAILED' | 'PROVIDER_REJECTED' | 'OBSERVATION_MISMATCH'
  | 'OPERATION_ABORTED' | 'BUDGET_EXCEEDED' | 'CLOSURE_UNCONFIRMED'
  | 'TRANSPORT_IN_USE' | 'TRANSPORT_CLOSED';
