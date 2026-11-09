import { getSystemErrorMap } from 'node:util';
import { commandErrorCodes } from '@openge/forge-command-runner';
import { processControlErrorCodes } from '@openge/forge-process-control';
import { record } from './errors.js';

const codes = new Set<string>([...getSystemErrorMap().values()].map(([code]) => code)
  .concat(Object.values(commandErrorCodes), Object.values(processControlErrorCodes)));
const stages = new Set(['provider', 'identity', 'bind', 'authorize', 'cleanup', 'lifecycle',
  'scope-deadline', 'scope-provider', 'scope-completion-deadline', 'missing-completion',
  'identity-wait-deadline', 'provider-deadline', 'exit-deadline', 'stream-close-deadline',
  'child-process-error', 'direct-child-cleanup', 'NATIVE_LOAD', 'NATIVE_CALL', 'FILETIME_ABI',
  'OPEN_PROCESS', 'PROCESS_ID', 'PROCESS_WAIT', 'GET_PROCESS_TIMES', 'FILE_TIME', 'CLOSE_HANDLE', 'IDENTITY_BINDING', 'IDENTITY_RESULT',
  'CREATE_JOB', 'SET_JOB_LIMITS', 'JOB_LIMIT_READBACK', 'ATTACH_STATE', 'OPEN_ROOT', 'ROOT_TIMES', 'ASSIGN_JOB',
  'QUERY_STATE', 'QUERY_JOB_MEMBERS', 'JOB_QUERY_ABORTED', 'QUERY_JOB', 'JOB_ROOT_MEMBERSHIP', 'JOB_MEMBER_INSTANCE',
  'JOB_MEMBER_OWNERSHIP', 'JOB_MEMBER_WAIT', 'JOB_MEMBER_EXIT_STATUS', 'CLOSE_MEMBER_HANDLE', 'JOB_ACCOUNTING_DEADLINE',
  'TERMINATE_JOB', 'CLOSE_HANDLES']);
const reasons = new Set(['INACTIVE', 'CHANNEL_CLOSED', 'CONTROL_DEADLINE', 'CONTROL_SEND', 'ROOT_INSTANCE',
  'BOOT_DEADLINE', 'CLOSE_DEADLINE', 'STOPPED', 'MISSING_CLOSURE', 'FINISHED', 'NOT_STARTED', 'UNEXPECTED_REPLY',
  'HELPER_REJECTED', 'EXIT_PROTOCOL', 'UNEXPECTED_MESSAGE', 'PROTOCOL', 'HELPER_START', 'OWNER_LOST', 'MISSING_ROOT_PID',
  'NOT_BOUND', 'FORCE_REQUIRED', 'ROOT_IDENTITY', 'HOST', 'NATIVE_PREBUILD']);

interface ProcessFailureSummary {
  readonly code?: string;
  readonly stage?: string;
  readonly reason?: string;
  readonly nativeCode?: number;
  readonly cause?: ProcessFailureSummary;
}
export const isKnownProcessFailureCode = (value: unknown): value is string => typeof value === 'string' && codes.has(value);

/** 只公开已知分类，最多三层；原消息、命令、路径和环境不进入持久报告。 */
export function summarizeProcessFailure(value: unknown, depth = 0): ProcessFailureSummary {
  const error = record(value), details = record(error.details);
  const cause = depth < 2 && error.cause !== undefined ? summarizeProcessFailure(error.cause, depth + 1) : undefined;
  return {
    ...(isKnownProcessFailureCode(error.code) ? {
      code: error.code,
      ...(typeof details.stage === 'string' && stages.has(details.stage) ? { stage: details.stage } : {}),
      ...(typeof details.reason === 'string' && reasons.has(details.reason) ? { reason: details.reason } : {}),
      ...(typeof details.nativeCode === 'number' && Number.isSafeInteger(details.nativeCode)
        && details.nativeCode >= 0 && details.nativeCode <= 0xffff_ffff ? { nativeCode: details.nativeCode } : {}),
    } : {}),
    ...(cause && Object.keys(cause).length ? { cause } : {}),
  };
}
