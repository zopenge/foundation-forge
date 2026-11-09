import { expect, it } from 'vitest';
import { CommandRunnerError } from '@openge/forge-command-runner';
import { ProcessControlError } from '@openge/forge-process-control';
import { summarizeProcessFailure } from '../src/node/managed-process-diagnostics.js';

it('preserves the classified provider cause without exposing launch data or messages', () => {
  const cause = new ProcessControlError('PROCESS_SCOPE_UNKNOWN', { reason: 'BOOT_DEADLINE', stage: 'OPEN_ROOT', nativeCode: 5,
    command: 'private-command', environment: { TOKEN: 'private-token' } });
  const error = new CommandRunnerError('COMMAND_SCOPE_FAILED', { stage: 'provider', input: 'private-input' }, cause);
  expect(summarizeProcessFailure(error)).toEqual({ code: 'COMMAND_SCOPE_FAILED', stage: 'provider',
    cause: { code: 'PROCESS_SCOPE_UNKNOWN', reason: 'BOOT_DEADLINE', stage: 'OPEN_ROOT', nativeCode: 5 } });
  expect(JSON.stringify(summarizeProcessFailure(error))).not.toContain('private');
});

it('preserves known operating-system codes and drops unknown diagnostic strings', () => {
  expect(summarizeProcessFailure(Object.assign(new Error('private-message'), { code: 'EBUSY', path: 'private-path', syscall: 'rename' })))
    .toEqual({ code: 'EBUSY' });
  expect(summarizeProcessFailure({ code: 'SECRET_CODE', details: { stage: 'SECRET_STAGE', reason: 'SECRET_REASON', nativeCode: 17 } }))
    .toEqual({});
  expect(summarizeProcessFailure(new ProcessControlError('PROCESS_SCOPE_UNKNOWN', { stage: 'SECRET_STAGE', reason: 'SECRET_REASON', nativeCode: -1 })))
    .toEqual({ code: 'PROCESS_SCOPE_UNKNOWN' });
  expect(summarizeProcessFailure(new Error('private-wrapper', { cause: Object.assign(new Error('private-cause'), { code: 'EPERM' }) })))
    .toEqual({ cause: { code: 'EPERM' } });
});

it('bounds cyclic cause chains and invalid native error numbers', () => {
  const error = Object.assign(new Error('private-message'), { code: 'EPERM' });
  error.cause = error;
  const summary = summarizeProcessFailure(error);
  expect(summary).toEqual({ code: 'EPERM', cause: { code: 'EPERM', cause: { code: 'EPERM' } } });
  for (const nativeCode of [NaN, Infinity, 1.5, 4_294_967_296]) {
    expect(summarizeProcessFailure(new ProcessControlError('PROCESS_SCOPE_UNKNOWN', { nativeCode }))).toEqual({ code: 'PROCESS_SCOPE_UNKNOWN' });
  }
});

it.each([
  'scope-deadline', 'scope-provider', 'scope-completion-deadline', 'missing-completion',
  'identity-wait-deadline', 'provider-deadline', 'exit-deadline', 'stream-close-deadline',
  'child-process-error', 'direct-child-cleanup', 'lifecycle',
  'NATIVE_CALL', 'FILETIME_ABI', 'OPEN_PROCESS', 'PROCESS_ID', 'PROCESS_WAIT',
  'GET_PROCESS_TIMES', 'FILE_TIME', 'CLOSE_HANDLE', 'IDENTITY_BINDING', 'IDENTITY_RESULT',
])('retains the existing fixed diagnostic stage: %s', stage => {
  const error = new CommandRunnerError('COMMAND_SCOPE_FAILED', { stage, input: 'private-input' });
  expect(summarizeProcessFailure(error)).toEqual({ code: 'COMMAND_SCOPE_FAILED', stage });
});
