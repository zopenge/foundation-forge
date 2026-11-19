import { LocalDirectoryLeaseError } from '@openge/forge-process-control-node';
import type { ReleaseDiagnostic, ReleaseErrorCode } from '../contracts.js';

export class ReleaseError extends Error {
  constructor(readonly code: ReleaseErrorCode, readonly details: Readonly<Record<string, unknown>> = {}) {
    super(code); this.name = 'ReleaseError';
  }
}
export function localLeaseDiagnostic(error: unknown): ReleaseDiagnostic | undefined {
  if (!(error instanceof LocalDirectoryLeaseError)) return;
  const code = { INVALID_INPUT: 'ARGUMENT_INVALID', DIRECTORY_CHANGED: 'SLOT_PATH', LOCKED: 'LOCKED', LOCK_OWNERSHIP: 'LOCK_OWNERSHIP',
    UNSUPPORTED: 'SOURCE_UNSUPPORTED', CANCELLED: 'CANCELLED', IO_FAILED: 'IO_FAILED' } as const;
  if (error.reason === 'NATIVE_CALL') return { code: 'SOURCE_UNSUPPORTED', details: { reason: 'RETIREMENT_NATIVE_UNAVAILABLE' } };
  return { code: code[error.code], details: error.code === 'CANCELLED' || error.code === 'LOCK_OWNERSHIP' ? {} : { reason: `RETIREMENT_${error.reason}` } };
}
export function redact(text: string): string {
  return text.replace(/(bearer\s+)[^\s"']+/giu, '$1[REDACTED]')
    .replace(/((?:token|password|secret|authorization|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',}]+/giu, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^/@\s]+@/giu, '$1[REDACTED]@');
}
export function assertActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ReleaseError('CANCELLED');
}
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
