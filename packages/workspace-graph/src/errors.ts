import type { WorkspaceGraphErrorCode } from './contracts.js';

export class WorkspaceGraphError extends Error {
  readonly code: WorkspaceGraphErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: WorkspaceGraphErrorCode, details: Readonly<Record<string, unknown>> = {}) {
    super(code);
    this.name = 'WorkspaceGraphError';
    this.code = code;
    this.details = details;
  }
}
