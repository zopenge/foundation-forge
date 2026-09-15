import type { SourceSnapshotErrorCode } from './contracts.js';
export class SourceSnapshotError extends Error {
  readonly code: SourceSnapshotErrorCode;
  readonly details: Readonly<Record<string, unknown>>;
  constructor(code: SourceSnapshotErrorCode, details: Readonly<Record<string, unknown>> = {}) {
    super(code);
    this.name = 'SourceSnapshotError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}
