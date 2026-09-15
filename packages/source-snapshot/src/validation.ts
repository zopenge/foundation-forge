import { validatePortableRelativePath } from '@openge/forge-path-safety';
import { SourceSnapshotError } from './errors.js';
import type { SnapshotObject } from './contracts.js';
export const compareStrings = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
export const assertCount = (value: number, field: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) throw new SourceSnapshotError('INVALID_INPUT', { field });
};
export const assertArray = (value: readonly unknown[], field: string): void => {
  if (!Array.isArray(value)) throw new SourceSnapshotError('INVALID_INPUT', { field });
  for (let index = 0; index < value.length; index++) {
    if (!(index in value) || value[index] === undefined || value[index] === null) throw new SourceSnapshotError('INVALID_INPUT', { field, index });
  }
};
export const assertProject = (projectId: string): void => {
  if (typeof projectId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(projectId)) throw new SourceSnapshotError('INVALID_PROJECT_ID');
};
export const objectPath = (value: string): string => {
  validatePortableRelativePath(value);
  if (!value.startsWith('objects/')) throw new SourceSnapshotError('INVALID_INPUT', { field: 'objectPath', path: value });
  return value;
};
export const uniquePaths = (values: readonly string[]): void => {
  assertArray(values, 'paths');
  const seen = new Set<string>(); const folded = new Set<string>();
  for (const value of values) {
    validatePortableRelativePath(value);
    if (seen.has(value)) throw new SourceSnapshotError('DUPLICATE_PATH', { path: value });
    if (folded.has(value.toLowerCase())) throw new SourceSnapshotError('CASE_COLLISION', { path: value });
    seen.add(value); folded.add(value.toLowerCase());
  }
};
export const normalizeObject = (value: SnapshotObject): SnapshotObject => {
  validatePortableRelativePath(value.path);
  if (!/^[a-f0-9]{64}$/u.test(value.sha256)) throw new SourceSnapshotError('INVALID_INPUT', { field: 'sha256', path: value.path });
  assertCount(value.byteLength, 'byteLength');
  return Object.freeze({ path: value.path, sha256: value.sha256, byteLength: value.byteLength });
};
