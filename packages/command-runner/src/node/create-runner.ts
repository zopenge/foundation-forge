import type { CommandRunner } from '../contracts.js';
import { CommandRunnerError } from '../errors.js';
import { positiveInteger } from '../normalize-spec.js';
import type { NodeCommandRunnerOptions } from './options.js';
import { startCommand } from './running-command.js';

export function createNodeCommandRunner(options: NodeCommandRunnerOptions): CommandRunner {
  if (typeof options.processControl?.listProcesses !== 'function' || typeof options.processControl.terminateProcessTree !== 'function') throw new CommandRunnerError('COMMAND_INVALID_SPEC', { field: 'processControl' });
  if (!['win32', 'posix'].includes(options.platform)) throw new CommandRunnerError('COMMAND_INVALID_SPEC', { field: 'platform' });
  positiveInteger(options.identityAcquisition.timeoutMs, 'COMMAND_INVALID_TIMEOUT', 'identityAcquisition.timeoutMs');
  positiveInteger(options.identityAcquisition.pollIntervalMs, 'COMMAND_INVALID_TIMEOUT', 'identityAcquisition.pollIntervalMs');
  positiveInteger(options.terminationTimeoutMs, 'COMMAND_INVALID_TIMEOUT', 'terminationTimeoutMs');
  if (!['force', 'graceful', 'graceful-then-force'].includes(options.terminationPolicy.mode)) throw new CommandRunnerError('COMMAND_INVALID_SPEC', { field: 'terminationPolicy' });
  if (options.terminationPolicy.mode === 'graceful-then-force') {
    if (!Number.isSafeInteger(options.terminationPolicy.gracePeriodMs) || options.terminationPolicy.gracePeriodMs < 0) throw new CommandRunnerError('COMMAND_INVALID_TIMEOUT', { field: 'terminationPolicy.gracePeriodMs' });
    positiveInteger(options.terminationPolicy.pollIntervalMs, 'COMMAND_INVALID_TIMEOUT', 'terminationPolicy.pollIntervalMs');
    if (options.terminationTimeoutMs < options.terminationPolicy.gracePeriodMs) throw new CommandRunnerError('COMMAND_INVALID_TIMEOUT', { field: 'terminationTimeoutMs' });
  }
  const configuration = Object.freeze({ ...options, identityAcquisition: Object.freeze({ ...options.identityAcquisition }), terminationPolicy: Object.freeze({ ...options.terminationPolicy }) });
  return {
    start: (spec, observer) => startCommand(configuration, spec, observer),
    run: (spec, observer) => startCommand(configuration, spec, observer).result,
  };
}
