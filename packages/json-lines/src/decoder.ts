import {
  jsonLinesErrorCodes,
  type JsonLinesDecoder,
  type JsonLinesDecoderOptions,
} from './contracts.js';
import { JsonLinesError } from './errors.js';

const defaultMaxLineBytes = 1_048_576;

export function createJsonLinesDecoder(
  options: JsonLinesDecoderOptions = {},
): JsonLinesDecoder {
  return new IncrementalJsonLinesDecoder(resolveMaxLineBytes(options));
}

class IncrementalJsonLinesDecoder implements JsonLinesDecoder {
  readonly #decoder = new TextDecoder('utf-8', { fatal: true });
  readonly #maxLineBytes: number;
  #byteOffset = 0;
  #closed = false;
  #line = 1;
  #pending: Uint8Array = new Uint8Array();

  constructor(maxLineBytes: number) {
    this.#maxLineBytes = maxLineBytes;
  }

  finish(): readonly unknown[] {
    this.#assertOpen();
    this.#closed = true;
    if (this.#pending.length === 0) {
      return [];
    }
    const value = this.#parseLine(this.#pending);
    this.#pending = new Uint8Array();
    return value === undefined ? [] : [value];
  }

  push(chunk: Uint8Array): readonly unknown[] {
    this.#assertOpen();
    this.#pending = concatenateBytes(this.#pending, chunk);
    const values: unknown[] = [];
    let lineStart = 0;
    for (let index = 0; index < this.#pending.length; index += 1) {
      if (this.#pending[index] !== 0x0a) {
        continue;
      }
      const rawLine = this.#pending.subarray(lineStart, index);
      const value = this.#parseLine(rawLine);
      if (value !== undefined) {
        values.push(value);
      }
      this.#byteOffset += rawLine.length + 1;
      this.#line += 1;
      lineStart = index + 1;
    }
    this.#pending = this.#pending.slice(lineStart);
    this.#assertLineSize(this.#pending);
    return values;
  }

  #assertLineSize(bytes: Uint8Array): void {
    const contentLength = bytes.at(-1) === 0x0d ? bytes.length - 1 : bytes.length;
    if (contentLength > this.#maxLineBytes) {
      throw new JsonLinesError(jsonLinesErrorCodes.lineTooLarge, {
        byteOffset: this.#byteOffset,
        line: this.#line,
      });
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new JsonLinesError(jsonLinesErrorCodes.decoderClosed, {
        byteOffset: this.#byteOffset,
        line: this.#line,
      });
    }
  }

  #parseLine(bytes: Uint8Array): unknown | undefined {
    this.#assertLineSize(bytes);
    const content = bytes.at(-1) === 0x0d ? bytes.subarray(0, -1) : bytes;
    let text: string;
    try {
      text = this.#decoder.decode(content);
    } catch (error) {
      throw new JsonLinesError(jsonLinesErrorCodes.invalidUtf8, {
        byteOffset: this.#byteOffset,
        cause: error,
        line: this.#line,
      });
    }
    if (text.trim().length === 0) {
      return undefined;
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new JsonLinesError(jsonLinesErrorCodes.invalidJson, {
        byteOffset: this.#byteOffset,
        cause: error,
        line: this.#line,
      });
    }
  }
}

function concatenateBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) {
    return right.slice();
  }
  if (right.length === 0) {
    return left;
  }
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left);
  combined.set(right, left.length);
  return combined;
}

function resolveMaxLineBytes(options: JsonLinesDecoderOptions): number {
  const value = options.maxLineBytes ?? defaultMaxLineBytes;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new JsonLinesError(jsonLinesErrorCodes.invalidOptions, { byteOffset: 0, line: 1 });
  }
  return value;
}
