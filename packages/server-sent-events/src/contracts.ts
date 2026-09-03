export interface ServerSentEvent {
  readonly data: string;
  readonly event?: string;
  readonly id?: string;
  readonly retry?: number;
}

export interface ServerSentEventDecoder {
  finish(): readonly ServerSentEvent[];
  push(chunk: Uint8Array): readonly ServerSentEvent[];
}

export interface ServerSentEventDecoderOptions {
  readonly maxEventBytes?: number;
}

export const serverSentEventErrorCodes = {
  decoderClosed: 'DECODER_CLOSED',
  eventTooLarge: 'EVENT_TOO_LARGE',
  invalidEvent: 'INVALID_EVENT',
  invalidOptions: 'INVALID_OPTIONS',
  invalidUtf8: 'INVALID_UTF8',
} as const;

export type ServerSentEventErrorCode = typeof serverSentEventErrorCodes[
  keyof typeof serverSentEventErrorCodes
];
