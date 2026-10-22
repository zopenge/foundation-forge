import type { OwnedProcessScopeProvider } from '@openge/forge-process-control';
import { createLinuxOwnedProcessScopeProvider, createWindowsOwnedProcessScopeProvider } from '@openge/forge-process-control-node';
import { ReleaseError } from './errors.js';

export function managedOwnedScopeProvider(): OwnedProcessScopeProvider {
  if (process.platform === 'win32') return createWindowsOwnedProcessScopeProvider();
  if (process.platform === 'linux') return createLinuxOwnedProcessScopeProvider();
  throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'OWNED_SCOPE_HOST' });
}
