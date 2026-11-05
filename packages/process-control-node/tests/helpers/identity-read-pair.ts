import type { ProcessIdentityReader } from '@openge/forge-process-control';

/** 同一个存活进程的两次新鲜观测；允许不同 reader 并行，统一取消并排空。 */
export async function readIdentityPair(reader: ProcessIdentityReader | readonly [ProcessIdentityReader, ProcessIdentityReader], pid: number, signal: AbortSignal) {
  const readers = 'readIdentity' in reader ? [reader, reader] : reader;
  const results = await Promise.allSettled(readers.map(async value => value.readIdentity({ pid, signal })));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  const [first, second] = results;
  if (first?.status !== 'fulfilled' || second?.status !== 'fulfilled') throw new Error('IDENTITY_PAIR_RESULT_MISSING');
  return [first.value, second.value] as const;
}
