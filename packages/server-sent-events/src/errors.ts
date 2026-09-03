import type { ServerSentEventErrorCode } from './contracts.js';

export class ServerSentEventError extends Error {
  readonly byteOffset: number;
  readonly code: ServerSentEventErrorCode;

  constructor(
    code: ServerSentEventErrorCode,
    details: { readonly byteOffset: number; readonly cause?: unknown },
  ) {
    super(code, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'ServerSentEventError';
    this.byteOffset = details.byteOffset;
    this.code = code;
  }
}
