export const jsonLinesErrorCodes = {
  decoderClosed: 'DECODER_CLOSED',
  invalidJson: 'INVALID_JSON',
  invalidOptions: 'INVALID_OPTIONS',
  invalidUtf8: 'INVALID_UTF8',
  lineTooLarge: 'LINE_TOO_LARGE',
  unencodableValue: 'UNENCODABLE_VALUE',
} as const;

export type JsonLinesErrorCode = typeof jsonLinesErrorCodes[keyof typeof jsonLinesErrorCodes];

export interface JsonLinesDecoderOptions {
  readonly maxLineBytes?: number;
}

export interface JsonLinesDecoder {
  finish(): readonly unknown[];
  push(chunk: Uint8Array): readonly unknown[];
}
