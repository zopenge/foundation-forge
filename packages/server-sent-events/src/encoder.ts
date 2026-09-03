import { serverSentEventErrorCodes, type ServerSentEvent } from './contracts.js';
import { ServerSentEventError } from './errors.js';

const encoder = new TextEncoder();

export function encodeServerSentEvent(event: ServerSentEvent): Uint8Array {
  assertSingleLine(event.event);
  assertSingleLine(event.id, true);
  if (event.retry !== undefined && (!Number.isSafeInteger(event.retry) || event.retry < 0)) {
    throw invalidEvent();
  }
  const lines: string[] = [];
  if (event.event !== undefined) {
    lines.push(`event: ${event.event}`);
  }
  if (event.id !== undefined) {
    lines.push(`id: ${event.id}`);
  }
  if (event.retry !== undefined) {
    lines.push(`retry: ${String(event.retry)}`);
  }
  for (const dataLine of event.data.split(/\r\n|\r|\n/u)) {
    lines.push(`data: ${dataLine}`);
  }
  return encoder.encode(`${lines.join('\n')}\n\n`);
}

function assertSingleLine(value: string | undefined, rejectNull = false): void {
  if (value !== undefined && (/\r|\n/u.test(value) || (rejectNull && value.includes('\0')))) {
    throw invalidEvent();
  }
}

function invalidEvent(): ServerSentEventError {
  return new ServerSentEventError(serverSentEventErrorCodes.invalidEvent, { byteOffset: 0 });
}
