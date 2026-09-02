import type { PathSafetyErrorCode } from './contracts.js';

export class PathSafetyError extends Error {
  readonly code: PathSafetyErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: PathSafetyErrorCode,
    details: Readonly<Record<string, unknown>> = {},
    cause?: unknown,
  ) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'PathSafetyError';
    this.code = code;
    this.details = details;
  }
}
