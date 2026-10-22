import type { Execution } from './execution.js';
import { ReleaseError } from './errors.js';

/** Git 的 NUL 协议不得经过 trim、行拆分或有损 UTF-8 解码。 */
export async function gitRecords(execution: Execution, args: readonly string[], consume: (value: string) => void): Promise<void> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '', count = 0;
  try {
    await execution.streamGit(args, chunk => {
      pending += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = pending.indexOf('\0')) !== -1) {
        const value = pending.slice(0, end); pending = pending.slice(end + 1);
        if (++count > 500_000 || Buffer.byteLength(value) > 65_536) throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'TREE_LIMIT' });
        consume(value);
      }
      if (Buffer.byteLength(pending) > 65_536) throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'TREE_RECORD_LIMIT' });
    });
    pending += decoder.decode();
    if (pending !== '') throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'INCOMPLETE_GIT_RECORD' });
  } catch (error) {
    if (error instanceof TypeError) throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'INVALID_UTF8' });
    throw error;
  }
}
export async function gitBlob(execution: Execution, object: string, maxBytes = 1_048_576): Promise<Buffer> {
  const chunks: Buffer[] = []; let bytes = 0;
  await execution.streamGit(['cat-file', 'blob', object], chunk => {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'BLOB_LIMIT' });
    chunks.push(Buffer.from(chunk));
  });
  return Buffer.concat(chunks);
}
