import type { ProcessControlProvider, ProcessIdentity, ProcessIdentityReader } from '@openge/forge-process-control';
import { identityReader, processControl } from '../../src/node/process-identities.js';

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
