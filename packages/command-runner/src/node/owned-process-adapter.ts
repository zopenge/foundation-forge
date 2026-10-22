import type { OwnedProcessCompletion, OwnedProcessScope } from '@openge/forge-process-control';
import type { CommandSpec } from '../contracts.js';
import { CommandRunnerError } from '../errors.js';
import { createEnvironment } from './environment.js';
import type { NodeCommandRunnerOptions } from './options.js';

export function startOwnedAdapter(options: NodeCommandRunnerOptions, spec: CommandSpec, callbacks: {
  output(stream: 'stdout' | 'stderr', chunk: Uint8Array): void;
  spawned(pid: number): void;
  failed(cause: unknown): void;
  completed(result: OwnedProcessCompletion): void;
}): OwnedProcessScope {
  if (!options.ownedScopeProvider || !spec.ownedScope) throw new CommandRunnerError('COMMAND_SCOPE_UNSUPPORTED');
  const process = options.ownedScopeProvider.start({ command: spec.command, args: spec.args ?? [], ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
    environment: createEnvironment(spec.environment ?? { mode: 'inherit' }, options.platform), binding: spec.ownedScope.binding,
    startupTimeoutMs: options.identityAcquisition.timeoutMs, terminationTimeoutMs: options.terminationTimeoutMs }, event => callbacks.output(event.stream, event.chunk));
  void process.rootPid.then(callbacks.spawned, callbacks.failed);
  void process.completion.then(async result => {
    try { await process.dispose(); callbacks.completed(result); }
    catch {
      callbacks.completed({ ...result, closure: { scopeId: process.scopeId, binding: spec.ownedScope?.binding ?? '', observedAt: new Date().toISOString(), status: 'unknown', reason: 'provider-failed' } });
    }
  }, callbacks.failed);
  return process;
}
