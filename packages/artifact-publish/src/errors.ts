import type {
  ArtifactPublicationErrorCode, ArtifactPublicationPhase, ArtifactPublicationReceipt,
  ArtifactTransportClosure,
} from './contracts.js';

export class ArtifactPublicationError extends Error {
  readonly code: ArtifactPublicationErrorCode;
  readonly phase: ArtifactPublicationPhase | undefined;
  readonly key: string | undefined;
  readonly statusCode: number | undefined;
  readonly receipt: ArtifactPublicationReceipt | undefined;
  readonly closure: ArtifactTransportClosure | undefined;

  constructor(code: ArtifactPublicationErrorCode, details: {
    readonly phase?: ArtifactPublicationPhase;
    readonly key?: string;
    readonly statusCode?: number;
    readonly receipt?: ArtifactPublicationReceipt;
    readonly closure?: ArtifactTransportClosure;
  } = {}) {
    super(code);
    this.name = 'ArtifactPublicationError';
    this.code = code;
    this.phase = details.phase;
    this.key = details.key;
    this.statusCode = details.statusCode;
    this.receipt = details.receipt;
    this.closure = details.closure;
  }
}
