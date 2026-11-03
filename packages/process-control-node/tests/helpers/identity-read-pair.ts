import type { ProcessIdentityReader } from '@openge/forge-process-control';

/** 同一个存活进程的两次新鲜观测；由调用者提供统一取消边界。 */
export async function readIdentityPair(reader: ProcessIdentityReader, pid: number, signal: AbortSignal) {
  const results = await Promise.allSettled([0, 1].map(async () => reader.readIdentity({ pid, signal })));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  const [first, second] = results;
  if (first?.status !== 'fulfilled' || second?.status !== 'fulfilled') throw new Error('IDENTITY_PAIR_RESULT_MISSING');
  return [first.value, second.value] as const;
}
