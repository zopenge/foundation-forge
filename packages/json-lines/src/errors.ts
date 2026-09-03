import type { JsonLinesErrorCode } from './contracts.js';

export class JsonLinesError extends Error {
  readonly byteOffset: number;
  readonly code: JsonLinesErrorCode;
  readonly line: number;

  constructor(
    code: JsonLinesErrorCode,
    details: { readonly byteOffset: number; readonly line: number; readonly cause?: unknown },
  ) {
    super(code, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'JsonLinesError';
    this.byteOffset = details.byteOffset;
    this.code = code;
    this.line = details.line;
  }
}
