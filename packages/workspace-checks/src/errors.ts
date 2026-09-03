import type { JsonValue } from '@openge/forge-deterministic-json';

import type { WorkspaceChecksErrorCode } from './contracts.js';

export class WorkspaceChecksError extends Error {
  readonly code: WorkspaceChecksErrorCode;
  readonly details: Readonly<Record<string, JsonValue>>;

  constructor(code: WorkspaceChecksErrorCode, details: Readonly<Record<string, JsonValue>> = {}) {
    super(code);
    this.name = 'WorkspaceChecksError';
    this.code = code;
    this.details = details;
  }
}
