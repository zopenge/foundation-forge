import type { CommandObserver, CommandResult, CommandRunner, CommandSpec } from '@openge/forge-command-runner';
import type { CommandPreparationReport } from './managed-startup-timing.js';

export interface ExecutionResult extends CommandResult { readonly preparation?: CommandPreparationReport }
export interface ExecutionLifecycle {
  execute(runner: CommandRunner, name: string, spec: CommandSpec, observer?: CommandObserver): Promise<ExecutionResult>;
  observeCheckout?<T>(operation: () => Promise<T>): Promise<T>;
}
