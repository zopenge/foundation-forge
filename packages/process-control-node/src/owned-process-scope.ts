import type { OwnedProcessScopeProvider } from '@openge/forge-process-control';
import { startSupervisor } from './owned-scope/supervisor.js';
import { createWindowsJob } from './owned-scope/windows-job.js';
import { createLinuxSubreaper } from './owned-scope/linux-subreaper.js';

export function createWindowsOwnedProcessScopeProvider(): OwnedProcessScopeProvider {
  return { start: (request, output) => startSupervisor(request, 'win32', createWindowsJob, output) };
}
export function createLinuxOwnedProcessScopeProvider(): OwnedProcessScopeProvider {
  return { start: (request, output) => startSupervisor(request, 'linux', createLinuxSubreaper, output) };
}
