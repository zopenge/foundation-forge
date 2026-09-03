import type { ZipArchiveErrorCode } from './contracts.js';

export class ZipArchiveError extends Error {
  readonly code: ZipArchiveErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ZipArchiveErrorCode,
    details: Readonly<Record<string, unknown>> = {},
    cause?: unknown,
  ) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'ZipArchiveError';
    this.code = code;
    this.details = details;
  }
}
