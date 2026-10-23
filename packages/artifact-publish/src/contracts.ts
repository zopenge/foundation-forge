export interface ArtifactObjectDescriptor {
  readonly key: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly contentType: string;
  readonly cacheControl: string;
}

export interface ArtifactBytes extends ArtifactObjectDescriptor {
  readonly bytes: Uint8Array;
}

export interface ArtifactActivationPlan {
  readonly sourceCommit: string;
  readonly immutablePrefix: string;
  readonly objects: readonly ArtifactObjectDescriptor[];
  readonly pointer: ArtifactBytes;
}

export interface ArtifactReleasePlan extends ArtifactActivationPlan {
  readonly objects: readonly ArtifactBytes[];
}

export interface ArtifactPublicationTarget {
  readonly provider: string;
  readonly namespace: string;
  readonly endpoint: string;
}

export interface ArtifactSerializationControl {
  readonly mode: 'external-serialization';
  readonly scope: string;
}

export interface ArtifactPublicationOptions {
  readonly concurrency: number;
  readonly timeoutMilliseconds: number;
  readonly closeTimeoutMilliseconds: number;
  readonly maxObjectBytes: number;
  readonly maxTotalBytes: number;
  readonly maxPointerBytes: number;
  readonly concurrencyControl: ArtifactSerializationControl;
  readonly signal?: AbortSignal;
}

export interface ArtifactRequestContext {
  readonly signal: AbortSignal;
  readonly timeoutMilliseconds: number;
}

export interface ArtifactRemoteObject {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly cacheControl: string;
}

export interface ArtifactTransportClosure {
  readonly status: 'closed' | 'unconfirmed';
  readonly activeRequests: number | null;
}

export interface ArtifactPublicationTransport {
  readonly target: ArtifactPublicationTarget;
  prepare(context: ArtifactRequestContext): Promise<void>;
  createObject(object: ArtifactBytes, context: ArtifactRequestContext): Promise<'created' | 'exists'>;
  readObject(request: { readonly key: string; readonly maxBytes: number }, context: ArtifactRequestContext): Promise<ArtifactRemoteObject>;
  replaceObject(object: ArtifactBytes, context: ArtifactRequestContext): Promise<void>;
  close(options: { readonly timeoutMilliseconds: number }): Promise<ArtifactTransportClosure>;
}

export type ArtifactWriteState = 'not-attempted' | 'accepted' | 'already-exists' | 'unknown';
export type ArtifactVerificationState = 'pending' | 'succeeded' | 'failed';
export type ArtifactPublicationPhase = 'validation' | 'prepare' | 'objects' | 'pointer' | 'close';
export type ArtifactPublicationErrorCode =
  | 'INVALID_PLAN' | 'INVALID_OPTIONS' | 'INVALID_TARGET' | 'INVALID_SOURCE'
  | 'INTEGRITY_MISMATCH' | 'METADATA_MISMATCH' | 'OPERATION_ABORTED'
  | 'BUDGET_EXCEEDED' | 'CLOSURE_UNCONFIRMED' | 'TRANSPORT_FAILED'
  | 'TRANSPORT_CLOSED' | 'TRANSPORT_IN_USE' | 'IMMUTABILITY_UNSUPPORTED' | 'AUTHENTICATION_FAILED'
  | 'OBJECT_MISSING' | 'OBJECT_CONFLICT' | 'RESPONSE_TOO_LARGE'
  | 'INVALID_REMOTE_RESPONSE' | 'INVALID_CONFIGURATION';

export interface ArtifactPublicationFailure {
  readonly code: ArtifactPublicationErrorCode;
  readonly phase: ArtifactPublicationPhase;
  readonly key?: string;
  readonly statusCode?: number;
}

export interface ArtifactObjectReceipt extends ArtifactObjectDescriptor {
  readonly writeState: ArtifactWriteState;
  readonly verificationState: ArtifactVerificationState;
}

export interface ArtifactPublicationReceipt {
  readonly schemaVersion: 1;
  readonly operation: 'publish' | 'activate';
  readonly outcome: 'succeeded' | 'failed';
  readonly target: ArtifactPublicationTarget;
  readonly sourceCommit: string;
  readonly immutablePrefix: string;
  readonly concurrencyControl: ArtifactSerializationControl;
  readonly objects: readonly ArtifactObjectReceipt[];
  readonly pointer: ArtifactObjectReceipt;
  readonly closure: ArtifactTransportClosure;
  readonly failure?: ArtifactPublicationFailure;
}
