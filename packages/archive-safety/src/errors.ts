import type { ArchiveSafetyErrorCode } from './contracts.js';

export class ArchiveSafetyError extends Error {
  readonly code: ArchiveSafetyErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ArchiveSafetyErrorCode,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(code);
    this.name = 'ArchiveSafetyError';
    this.code = code;
    this.details = details;
  }
}
