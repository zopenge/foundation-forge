import type { ReleaseErrorCode } from '../contracts.js';

export class ReleaseError extends Error {
  constructor(readonly code: ReleaseErrorCode, readonly details: Readonly<Record<string, unknown>> = {}) {
    super(code); this.name = 'ReleaseError';
  }
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
