import type { ProcessDescriptor, ProcessIdentity } from '@openge/forge-process-control';
import { createWindowsTestProcessDescriptorReader } from '../../../process-control-node/test-process-ancestry.mjs';

type Query = (pids: readonly number[], signal: AbortSignal) => Promise<readonly ProcessDescriptor[]>;
const invalid = () => new Error('FIXTURE_ANCESTRY_UNBOUND');
const validPid = (value: unknown): value is number => typeof value === 'number'
  && Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff;
const reader = createWindowsTestProcessDescriptorReader();
const queryWindows: Query = async (pids, signal) => {
  const rows: ProcessDescriptor[] = [];
  for (const pid of pids) {
    signal.throwIfAborted();
    const row = await reader.readDescriptor({ pid, signal });
    if (row) rows.push(row);
  }
  return rows;
};

/** 仅沿自有叶节点发现祖先，再对同一 PID 集合重新读取身份和父边。 */
export async function captureWindowsFixtureAncestry(owner: ProcessIdentity, leafPid: number, options: {
  readonly signal?: AbortSignal; readonly query?: Query;
} = {}): Promise<ProcessIdentity[]> {
  if (!validPid(owner.pid) || !validPid(leafPid) || owner.pid === leafPid || !owner.startToken) throw invalid();
  const signal = options.signal ?? AbortSignal.timeout(10_000); signal.throwIfAborted();
  const read = async (pids: readonly number[], phase: 'initial' | 'parent' | 'recheck') => {
    const requested = new Set(pids), result = new Map<number, ProcessDescriptor>();
    if (!pids.length || requested.size !== pids.length || !pids.every(validPid)) throw invalid();
    try {
      signal.throwIfAborted();
      const rows = await (options.query ?? queryWindows)(pids, signal);
      signal.throwIfAborted();
      for (const row of rows) {
        if (!requested.has(row.pid) || result.has(row.pid) || typeof row.startToken !== 'string' || !row.startToken.trim()
          || row.parentPid === undefined || !Number.isSafeInteger(row.parentPid) || row.parentPid < 0 || row.parentPid > 0xffffffff) throw invalid();
        result.set(row.pid, row);
      }
      if (result.size !== requested.size) throw invalid();
      return result;
    } catch (error) { throw new Error(`FIXTURE_ANCESTRY_QUERY_${phase}`, { cause: error }); }
  };
  const initial = await read([owner.pid, leafPid], 'initial');
  if (initial.get(owner.pid)?.startToken !== owner.startToken) throw invalid();
  const chain: ProcessDescriptor[] = [], seen = new Set<number>(); let cursor = leafPid;
  while (cursor !== owner.pid && chain.length < 32) {
    if (seen.has(cursor)) throw invalid(); seen.add(cursor);
    const row = initial.get(cursor) ?? (await read([cursor], 'parent')).get(cursor);
    if (!row || !validPid(row.parentPid)) throw invalid();
    initial.set(cursor, row); chain.push(row); cursor = row.parentPid;
  }
  if (cursor !== owner.pid) throw invalid();
  const current = await read([...initial.keys()], 'recheck');
  for (const [pid, row] of initial) {
    const fresh = current.get(pid);
    if (fresh?.startToken !== row.startToken || fresh.parentPid !== row.parentPid) throw invalid();
  }
  signal.throwIfAborted(); return chain.map(({ pid, startToken }) => ({ pid, startToken }));
}
