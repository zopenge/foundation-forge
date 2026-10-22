import { createPosixProcessControl, createPosixProcessIdentityReader, createWindowsProcessControl, createWindowsProcessIdentityReader } from '@openge/forge-process-control-node';
import type { RecordedIdentity } from './release-context.js';
import { assertActive, ReleaseError } from './errors.js';

export const processControl = () => process.platform === 'win32' ? createWindowsProcessControl({ listenerBackend: 'netstat' }) : createPosixProcessControl({ listenerBackend: 'lsof' });
export const identityReader = () => process.platform === 'win32' ? createWindowsProcessIdentityReader() : createPosixProcessIdentityReader();
export async function currentCoordinator(signal?: AbortSignal): Promise<RecordedIdentity> {
  assertActive(signal);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10_000);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const value = await identityReader().readIdentity({ pid: process.pid, signal: combined });
    assertActive(signal);
    if (value.status === 'FOUND' && value.identity.pid === process.pid && value.identity.startToken.length <= 128) return value.identity;
  } catch { assertActive(signal); }
  finally { clearTimeout(timer); }
  throw new ReleaseError('PROCESS_STATE_UNKNOWN', { reason: 'COORDINATOR_IDENTITY' });
}
