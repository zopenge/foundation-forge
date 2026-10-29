import { Execution } from './execution.js';
import type { ReleaseConfig, ReleaseStep } from '../contracts.js';
import type { ExecutionLifecycle } from './release-context.js';
import { identityReader } from './process-identities.js';

export function createManagedExecution(cwd: string, config: Pick<ReleaseConfig, 'limits'>, signal: AbortSignal | undefined,
  steps: ReleaseStep[], lifecycle?: ExecutionLifecycle): Execution {
  return new Execution(cwd, config, signal, steps, lifecycle, identityReader());
}
