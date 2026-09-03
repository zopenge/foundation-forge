import { jsonLinesErrorCodes, type JsonLinesDecoderOptions } from './contracts.js';
import { createJsonLinesDecoder } from './decoder.js';
import { JsonLinesError } from './errors.js';

const encoder = new TextEncoder();

export function encodeJsonLine(value: unknown): Uint8Array {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    throw new JsonLinesError(jsonLinesErrorCodes.unencodableValue, {
      byteOffset: 0,
      cause: error,
      line: 1,
    });
  }
  if (text === undefined) {
    throw new JsonLinesError(jsonLinesErrorCodes.unencodableValue, {
      byteOffset: 0,
      line: 1,
    });
  }
  return encoder.encode(`${text}\n`);
}

export function parseJsonLines(
  input: string | Uint8Array,
  options: JsonLinesDecoderOptions = {},
): readonly unknown[] {
  const decoder = createJsonLinesDecoder(options);
  const bytes = typeof input === 'string' ? encoder.encode(input) : input;
  return [...decoder.push(bytes), ...decoder.finish()];
}
