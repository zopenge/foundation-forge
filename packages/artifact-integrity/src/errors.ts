import type { ArtifactIntegrityErrorCode } from './contracts.js';

export class ArtifactIntegrityError extends Error {
  readonly code: ArtifactIntegrityErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ArtifactIntegrityErrorCode,
    details: Readonly<Record<string, unknown>> = {},
    cause?: unknown,
  ) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'ArtifactIntegrityError';
    this.code = code;
    this.details = details;
  }
}
