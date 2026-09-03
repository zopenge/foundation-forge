import type { WorkspacePnpmErrorCode } from './contracts.js';

export class WorkspacePnpmError extends Error {
  readonly code: WorkspacePnpmErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: WorkspacePnpmErrorCode,
    details: Readonly<Record<string, unknown>> = {},
    cause?: unknown,
  ) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'WorkspacePnpmError';
    this.code = code;
    this.details = details;
  }
}
