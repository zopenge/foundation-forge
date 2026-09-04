import type { CommandErrorCode } from './contracts.js';
export class CommandRunnerError extends Error {
  constructor(readonly code: CommandErrorCode, readonly details: Readonly<Record<string, unknown>> = {}, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'CommandRunnerError';
  }
}
