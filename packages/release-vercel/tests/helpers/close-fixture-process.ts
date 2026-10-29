import type { ProcessControlProvider, ProcessDescriptor, ProcessIdentity, ProcessIdentityReader } from '@openge/forge-process-control';
import { identityReader, processControl } from '../../src/node/process-identities.js';
import { captureWindowsFixtureAncestry } from './windows-fixture-ancestry.js';

interface CleanupOptions {
  readonly control?: Pick<ProcessControlProvider, 'terminateProcessTree'>;
  readonly reader?: ProcessIdentityReader;
  readonly signal?: AbortSignal;
}

export async function closeFixtureIdentity(identity: ProcessIdentity, options: CleanupOptions = {}): Promise<void> {
  const signal = options.signal === undefined ? {} : { signal: options.signal };
  try {
    await (options.control ?? processControl()).terminateProcessTree({
      process: identity, policy: { mode: 'force' }, ...signal,
    });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'PROCESS_IDENTITY_UNAVAILABLE')) throw error;
    // 原进程可能已被自有 scope 清理；只有重新确认不存在才完成测试清理。
    const current = await (options.reader ?? identityReader()).readIdentity({ pid: identity.pid, ...signal });
    if (current.status !== 'ABSENT') throw error;
  }
}

/** 从自有 hook PID 向上核验真实身份链；只查明确 PID 集合，绑定完成后才交给调用方清理。 */
export async function captureFixtureAncestry(owner: ProcessIdentity, leafPid: number, options: {
  readonly control?: Pick<ProcessControlProvider, 'listProcesses'>; readonly signal?: AbortSignal;
} = {}): Promise<ProcessIdentity[]> {
  const validPid = (pid: number) => Number.isSafeInteger(pid) && pid > 0;
  const invalid = () => new Error('FIXTURE_ANCESTRY_UNBOUND');
  if (!validPid(owner.pid) || !validPid(leafPid) || leafPid === owner.pid || !owner.startToken) throw invalid();
  if (!options.control && process.platform === 'win32') return captureWindowsFixtureAncestry(owner, leafPid, options);
  const control = options.control ?? processControl(), signal = options.signal ?? AbortSignal.timeout(10_000);
  const read = async (pids: readonly number[], phase: 'initial' | 'parent' | 'recheck'): Promise<Map<number, ProcessDescriptor>> => {
    const requested = new Set(pids), result = new Map<number, ProcessDescriptor>();
    if (!pids.length || requested.size !== pids.length || !pids.every(validPid)) throw invalid();
    try {
      signal.throwIfAborted();
      const rows = await control.listProcesses({ pids: [...pids], signal });
      signal.throwIfAborted();
      for (const row of rows) {
        if (!requested.has(row.pid) || result.has(row.pid) || !row.startToken) throw invalid();
        result.set(row.pid, row);
      }
      if (result.size !== requested.size) throw invalid();
      return result;
    } catch (error) { throw new Error(`FIXTURE_ANCESTRY_QUERY_${phase}`, { cause: error }); }
  };
  const initial = await read([owner.pid, leafPid], 'initial');
  if (initial.get(owner.pid)?.startToken !== owner.startToken) throw invalid();
  const chain: ProcessDescriptor[] = [], seen = new Set<number>();
  let pid = leafPid, bound = false;
  for (let depth = 0; depth < 32; depth++) {
    if (pid === owner.pid) { bound = true; break; }
    if (seen.has(pid)) throw invalid(); seen.add(pid);
    const row = (pid === leafPid ? initial : await read([pid], 'parent')).get(pid);
    if (!row) throw invalid();
    if (row.parentPid === undefined || !validPid(row.parentPid)) throw invalid();
    chain.push(row); pid = row.parentPid;
  }
  if (!bound) throw invalid();
  // 发现与使用之间再次核对实例及父边，不能把 PID 复用或换父进程当成归属证明。
  const current = await read([...chain.map(row => row.pid), owner.pid], 'recheck');
  for (const row of chain) {
    const fresh = current.get(row.pid);
    if (fresh?.startToken !== row.startToken || fresh.parentPid !== row.parentPid) throw invalid();
  }
  if (current.get(owner.pid)?.startToken !== owner.startToken) throw invalid();
  return chain.map(({ pid: observedPid, startToken }) => ({ pid: observedPid, startToken }));
}
