import type { GeneratedArtifactErrorCode } from './contracts.js';
export class GeneratedArtifactError extends Error {
  readonly code: GeneratedArtifactErrorCode;
  readonly details: Readonly<Record<string, unknown>>;
  constructor(code: GeneratedArtifactErrorCode, details: Readonly<Record<string, unknown>> = {}, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'GeneratedArtifactError';
    this.code = code;
    this.details = details;
  }
}
