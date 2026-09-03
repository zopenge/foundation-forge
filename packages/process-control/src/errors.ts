import type { ProcessControlErrorCode } from './contracts.js';

export class ProcessControlError extends Error {
  readonly code: ProcessControlErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ProcessControlErrorCode,
    details: Readonly<Record<string, unknown>> = {},
    cause?: unknown,
  ) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'ProcessControlError';
    this.code = code;
    this.details = details;
  }
}
