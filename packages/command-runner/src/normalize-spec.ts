import type { CommandEnvironment, CommandErrorCode, CommandSpec } from './contracts.js';
import { CommandRunnerError } from './errors.js';

export function positiveInteger(value: number, code: CommandErrorCode, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new CommandRunnerError(code, { field, value });
  }
}

function validText(value: unknown, field: string, allowEmpty = false): void {
  if (typeof value !== 'string' || value.includes('\0') || (!allowEmpty && value.trim() === '')) {
    throw new CommandRunnerError('COMMAND_INVALID_SPEC', { field });
  }
}

export function normalizeCommandSpec(spec: CommandSpec): CommandSpec {
  validText(spec.command, 'command');
  for (const arg of spec.args ?? []) validText(arg, 'args', true);
  if (spec.cwd !== undefined) validText(spec.cwd, 'cwd');
  if (spec.timeoutMs !== undefined) positiveInteger(spec.timeoutMs, 'COMMAND_INVALID_TIMEOUT', 'timeoutMs');
  if (spec.heartbeatMs !== undefined) positiveInteger(spec.heartbeatMs, 'COMMAND_INVALID_HEARTBEAT', 'heartbeatMs');
  const output = spec.output ?? { mode: 'events' };
  if (!['events', 'capture', 'ignore'].includes(output.mode)) throw new CommandRunnerError('COMMAND_INVALID_SPEC', { field: 'output.mode' });
  if (output.mode === 'capture') {
    positiveInteger(output.maxBytesPerStream, 'COMMAND_INVALID_CAPTURE_LIMIT', 'output.maxBytesPerStream');
    if (!['truncate', 'fail'].includes(output.overflow)) throw new CommandRunnerError('COMMAND_INVALID_SPEC', { field: 'output.overflow' });
  }
  const environment = spec.environment ?? { mode: 'inherit' };
  if (!['inherit', 'replace'].includes(environment.mode) || (environment.mode === 'replace' && environment.values === undefined)) {
    throw new CommandRunnerError('COMMAND_INVALID_SPEC', { field: 'environment' });
  }
  for (const [key, value] of Object.entries(environment.values ?? {})) {
    validText(key, 'environment.key');
    if (key.includes('=')) throw new CommandRunnerError('COMMAND_INVALID_SPEC', { field: 'environment.key' });
    if (value !== undefined || environment.mode === 'replace') validText(value, 'environment.value', true);
  }
  const frozenEnvironment: CommandEnvironment = environment.mode === 'replace'
    ? Object.freeze({ mode: 'replace', values: Object.freeze({ ...environment.values }) })
    : Object.freeze({ mode: 'inherit', ...(environment.values === undefined ? {} : { values: Object.freeze({ ...environment.values }) }) });
  return Object.freeze({
    ...spec,
    args: Object.freeze([...(spec.args ?? [])]),
    environment: frozenEnvironment,
    output: Object.freeze({ ...output }),
  });
}
