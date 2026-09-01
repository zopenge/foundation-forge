import type { RepositoryFilesErrorCode } from './contracts.js';

export class RepositoryFilesError extends Error {
  readonly code: RepositoryFilesErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: RepositoryFilesErrorCode,
    details: Readonly<Record<string, unknown>> = {},
    cause?: unknown,
  ) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'RepositoryFilesError';
    this.code = code;
    this.details = details;
  }
}
