import type { ArtifactTransportClosure } from '../contracts.js';
import type { ArtifactOperationErrorCode, ArtifactOperationReceipt } from './contracts.js';

export class ArtifactOperationError extends Error {
  readonly code: ArtifactOperationErrorCode;
  readonly receipt: ArtifactOperationReceipt | undefined;
  readonly closure: ArtifactTransportClosure | undefined;

  constructor(code: ArtifactOperationErrorCode, options: {
    readonly receipt?: ArtifactOperationReceipt;
    readonly closure?: ArtifactTransportClosure;
  } = {}) {
    super(code);
    this.name = 'ArtifactOperationError';
    this.code = code;
    this.receipt = options.receipt;
    this.closure = options.closure;
  }
}
