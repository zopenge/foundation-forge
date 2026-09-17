import { open } from 'node:fs/promises';
import { SourceSnapshotError } from '../errors.js';
import { failSnapshotReadLimit } from '../read-budget.js';

export interface ReadByteLimit {
  readonly maxBytes: number;
  readonly field: 'maxObjectBytes' | 'maxTotalBytes';
}
/** 使用已打开句柄核对大小；读取过程中不按增长后的文件重新扩大分配。 */
export const readBoundedBytes = async (target: string, logicalPath: string, limit: ReadByteLimit): Promise<Uint8Array> => {
  if (!Number.isSafeInteger(limit.maxBytes) || limit.maxBytes < 0) throw new SourceSnapshotError('INVALID_INPUT', { field: limit.field });
  const handle = await open(target, 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new SourceSnapshotError('MANAGED_PATH_UNSAFE', { path: logicalPath });
    if (!Number.isSafeInteger(metadata.size) || metadata.size > limit.maxBytes) failSnapshotReadLimit(limit.field);
    const bytes = new Uint8Array(metadata.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const extra = await handle.read(new Uint8Array(1), 0, 1, offset);
    if (offset !== metadata.size || extra.bytesRead !== 0) {
      throw new SourceSnapshotError('OBJECT_INTEGRITY_MISMATCH', { path: logicalPath, reason: 'size-changed' });
    }
    return bytes;
  } finally { await handle.close(); }
};
