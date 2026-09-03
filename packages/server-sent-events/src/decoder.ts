import {
  serverSentEventErrorCodes,
  type ServerSentEvent,
  type ServerSentEventDecoder,
  type ServerSentEventDecoderOptions,
} from './contracts.js';
import { ServerSentEventError } from './errors.js';

const defaultMaxEventBytes = 1_048_576;

export function createServerSentEventDecoder(
  options: ServerSentEventDecoderOptions = {},
): ServerSentEventDecoder {
  return new IncrementalServerSentEventDecoder(resolveMaxEventBytes(options));
}

class IncrementalServerSentEventDecoder implements ServerSentEventDecoder {
  readonly #decoder = new TextDecoder('utf-8', { fatal: true });
  readonly #maxEventBytes: number;
  #byteOffset = 0;
  #closed = false;
  #data: string[] = [];
  #event: string | undefined;
  #eventBytes = 0;
  #id: string | undefined;
  #pending: Uint8Array = new Uint8Array();
  #retry: number | undefined;

  constructor(maxEventBytes: number) {
    this.#maxEventBytes = maxEventBytes;
  }

  finish(): readonly ServerSentEvent[] {
    this.#assertOpen();
    this.#closed = true;
    const events = this.#drain(true);
    const finalEvent = this.#dispatch();
    return finalEvent === undefined ? events : [...events, finalEvent];
  }

  push(chunk: Uint8Array): readonly ServerSentEvent[] {
    this.#assertOpen();
    this.#pending = concatenateBytes(this.#pending, chunk);
    return this.#drain(false);
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new ServerSentEventError(serverSentEventErrorCodes.decoderClosed, {
        byteOffset: this.#byteOffset,
      });
    }
  }

  #dispatch(): ServerSentEvent | undefined {
    if (this.#data.length === 0) {
      this.#event = undefined;
      this.#eventBytes = 0;
      this.#retry = undefined;
      return undefined;
    }
    const result: ServerSentEvent = {
      data: this.#data.join('\n'),
      ...(this.#event === undefined || this.#event.length === 0 ? {} : { event: this.#event }),
      ...(this.#id === undefined ? {} : { id: this.#id }),
      ...(this.#retry === undefined ? {} : { retry: this.#retry }),
    };
    this.#data = [];
    this.#event = undefined;
    this.#eventBytes = 0;
    this.#retry = undefined;
    return result;
  }

  #drain(finishing: boolean): ServerSentEvent[] {
    const events: ServerSentEvent[] = [];
    let lineStart = 0;
    let index = 0;
    while (index < this.#pending.length) {
      const byte = this.#pending[index];
      if (byte !== 0x0a && byte !== 0x0d) {
        index += 1;
        continue;
      }
      if (byte === 0x0d && index + 1 === this.#pending.length && !finishing) {
        break;
      }
      const terminatorLength = byte === 0x0d && this.#pending[index + 1] === 0x0a ? 2 : 1;
      const rawLine = this.#pending.subarray(lineStart, index);
      this.#eventBytes += rawLine.length + terminatorLength;
      this.#assertEventSize();
      const event = this.#processLine(rawLine);
      if (event !== undefined) {
        events.push(event);
      }
      index += terminatorLength;
      this.#byteOffset += rawLine.length + terminatorLength;
      lineStart = index;
    }
    this.#pending = this.#pending.slice(lineStart);
    if (this.#eventBytes + this.#pending.length > this.#maxEventBytes) {
      this.#throwEventTooLarge();
    }
    if (finishing && this.#pending.length > 0) {
      this.#eventBytes += this.#pending.length;
      this.#assertEventSize();
      const event = this.#processLine(this.#pending);
      if (event !== undefined) {
        events.push(event);
      }
      this.#pending = new Uint8Array();
    }
    return events;
  }

  #processLine(bytes: Uint8Array): ServerSentEvent | undefined {
    let line: string;
    try {
      line = this.#decoder.decode(bytes);
    } catch (error) {
      throw new ServerSentEventError(serverSentEventErrorCodes.invalidUtf8, {
        byteOffset: this.#byteOffset,
        cause: error,
      });
    }
    if (line.length === 0) {
      return this.#dispatch();
    }
    if (line.startsWith(':')) {
      return undefined;
    }
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const rawValue = separator < 0 ? '' : line.slice(separator + 1);
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;
    if (field === 'data') {
      this.#data.push(value);
    } else if (field === 'event') {
      this.#event = value;
    } else if (field === 'id' && !value.includes('\0')) {
      this.#id = value;
    } else if (field === 'retry' && /^\d+$/u.test(value)) {
      this.#retry = Number(value);
    }
    return undefined;
  }

  #assertEventSize(): void {
    if (this.#eventBytes > this.#maxEventBytes) {
      this.#throwEventTooLarge();
    }
  }

  #throwEventTooLarge(): never {
    throw new ServerSentEventError(serverSentEventErrorCodes.eventTooLarge, {
      byteOffset: this.#byteOffset,
    });
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

function resolveMaxEventBytes(options: ServerSentEventDecoderOptions): number {
  const value = options.maxEventBytes ?? defaultMaxEventBytes;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ServerSentEventError(serverSentEventErrorCodes.invalidOptions, { byteOffset: 0 });
  }
  return value;
}
