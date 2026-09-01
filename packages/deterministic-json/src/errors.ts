import type { DeterministicJsonErrorCode } from './contracts.js';

export class DeterministicJsonError extends Error {
  readonly code: DeterministicJsonErrorCode;
  readonly path: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: DeterministicJsonErrorCode,
    path: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(code);
    this.name = 'DeterministicJsonError';
    this.code = code;
    this.path = path;
    this.details = details;
  }
}
