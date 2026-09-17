import type { SnapshotObject } from './contracts.js';
import type { SnapshotObjectBytes, SnapshotReadLimits } from './content-contracts.js';
import { SourceSnapshotError } from './errors.js';
import { cloneSnapshotBytes, snapshotByteLength } from './read-bytes.js';

export const failSnapshotReadLimit = (field: keyof SnapshotReadLimits): never => {
  throw new SourceSnapshotError('TEXT_READ_LIMIT_EXCEEDED', { field });
};
export const validateSnapshotReadLimits = (limits: SnapshotReadLimits): void => {
  for (const field of ['maxObjectBytes', 'maxFileBytes', 'maxTotalBytes'] as const) {
    const value = limits[field];
    if (!Number.isSafeInteger(value) || value <= 0) throw new SourceSnapshotError('INVALID_INPUT', { field });
  }
};
export const assertSnapshotObjectBudget = (requirements: readonly SnapshotObject[], limits: SnapshotReadLimits): void => {
  let total = 0;
  for (const object of requirements) {
    if (!Number.isSafeInteger(object.byteLength) || object.byteLength < 0) {
      throw new SourceSnapshotError('OBJECT_INTEGRITY_MISMATCH', { path: object.path });
    }
    if (object.byteLength > limits.maxObjectBytes) failSnapshotReadLimit('maxObjectBytes');
    if (object.byteLength > limits.maxTotalBytes - total) failSnapshotReadLimit('maxTotalBytes');
    total += object.byteLength;
  }
};

/** 所有路径、声明和实际大小通过预检后，才复制必要对象。 */
export const copySnapshotReadObjects = (
  requirements: readonly SnapshotObject[], objects: readonly SnapshotObjectBytes[], limits: SnapshotReadLimits,
): ReadonlyMap<string, Uint8Array> => {
  const requiredPaths = new Set(requirements.map(object => object.path));
  const supplied = new Map<string, SnapshotObjectBytes>();
  for (const object of objects) {
    if (supplied.has(object.path)) throw new SourceSnapshotError('OBJECT_CONFLICT', { path: object.path });
    supplied.set(object.path, object);
  }
  for (const path of supplied.keys()) {
    if (!requiredPaths.has(path)) throw new SourceSnapshotError('OBJECT_CONFLICT', { path, reason: 'unexpected-object' });
  }
  assertSnapshotObjectBudget(requirements, limits);
  let total = 0;
  const bytesByPath = new Map<string, Uint8Array>();
  const lengthsByPath = new Map<string, number>();
  for (const requirement of requirements) {
    const bytes = supplied.get(requirement.path)?.bytes;
    if (bytes === undefined) throw new SourceSnapshotError('OBJECT_MISSING', { path: requirement.path });
    const length = snapshotByteLength(bytes, requirement.path);
    if (length > limits.maxObjectBytes) failSnapshotReadLimit('maxObjectBytes');
    if (length > limits.maxTotalBytes - total) failSnapshotReadLimit('maxTotalBytes');
    total += length;
    lengthsByPath.set(requirement.path, length);
    bytesByPath.set(requirement.path, bytes);
  }
  for (const requirement of requirements) {
    if (lengthsByPath.get(requirement.path) !== requirement.byteLength) {
      throw new SourceSnapshotError('OBJECT_INTEGRITY_MISMATCH', { path: requirement.path });
    }
  }
  return new Map(requirements.map(requirement => {
    const bytes = bytesByPath.get(requirement.path);
    if (bytes === undefined) throw new SourceSnapshotError('OBJECT_MISSING', { path: requirement.path });
    return [requirement.path, cloneSnapshotBytes(bytes, requirement.byteLength, requirement.path)];
  }));
};
