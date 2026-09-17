import { SourceSnapshotError } from './errors.js';

const byteLengthGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')?.get;

/** 读取原生字节存储长度，不信任调用方覆盖的属性。 */
export const snapshotByteLength = (bytes: Uint8Array, path: string): number => {
  let length: unknown;
  try { length = byteLengthGetter?.call(bytes); }
  catch { throw new SourceSnapshotError('OBJECT_INTEGRITY_MISMATCH', { path, reason: 'invalid-byte-storage' }); }
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
    throw new SourceSnapshotError('OBJECT_INTEGRITY_MISMATCH', { path, reason: 'invalid-byte-storage' });
  }
  return length;
};

/** 原生 TypedArray 复制不执行调用方提供的 iterator。 */
export const cloneSnapshotBytes = (bytes: Uint8Array, byteLength: number, path: string): Uint8Array => {
  if (snapshotByteLength(bytes, path) !== byteLength) throw new SourceSnapshotError('OBJECT_INTEGRITY_MISMATCH', { path, reason: 'byte-storage-changed' });
  const copy = new Uint8Array(byteLength);
  try { Uint8Array.prototype.set.call(copy, bytes); }
  catch { throw new SourceSnapshotError('OBJECT_INTEGRITY_MISMATCH', { path, reason: 'byte-storage-changed' }); }
  return copy;
};
