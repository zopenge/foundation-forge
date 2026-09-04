import type { RepositoryContextErrorCode } from './contracts.js';

export class RepositoryContextError extends Error {
  constructor(readonly code: RepositoryContextErrorCode, readonly details: Readonly<Record<string, unknown>> = {}) {
    super(code);
    this.name = 'RepositoryContextError';
  }
}

export function validateLimit(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RepositoryContextError('INVALID_LIMIT', { field, value });
}

export function validateIdentifier(value: unknown, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) throw new RepositoryContextError('INVALID_REGISTRY', { field });
}

export function validateStringList(value: unknown, field: string): asserts value is readonly string[] {
  if (!Array.isArray(value)) throw new RepositoryContextError('INVALID_REGISTRY', { field });
  for (const item of value) {
    if (typeof item !== 'string') throw new RepositoryContextError('INVALID_REGISTRY', { field });
  }
}
