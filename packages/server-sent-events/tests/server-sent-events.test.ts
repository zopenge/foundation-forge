import { expect, test } from 'vitest';

import {
  createServerSentEventDecoder,
  encodeServerSentEvent,
} from '../src/index.js';

test('decodes SSE fields across arbitrary UTF-8 byte boundaries', () => {
  const bytes = new TextEncoder().encode(
    ': keepalive\r\nid: 7\r\nevent: update\r\ndata: 第一行\r\ndata: 第二行\r\nretry: 1500\r\n\r\n',
  );

  for (let split = 0; split <= bytes.length; split += 1) {
    const decoder = createServerSentEventDecoder();
    const events = [
      ...decoder.push(bytes.subarray(0, split)),
      ...decoder.push(bytes.subarray(split)),
      ...decoder.finish(),
    ];

    expect(events).toEqual([{
      data: '第一行\n第二行',
      event: 'update',
      id: '7',
      retry: 1500,
    }]);
  }
});

test('reports invalid UTF-8 with a structured byte offset', () => {
  const decoder = createServerSentEventDecoder();

  expect(() => decoder.push(Uint8Array.of(0xc3, 0x28, 0x0a))).toThrowError(
    expect.objectContaining({ code: 'INVALID_UTF8', byteOffset: 0 }),
  );
});

test('enforces the configured maximum buffered event size', () => {
  const decoder = createServerSentEventDecoder({ maxEventBytes: 7 });

  expect(() => decoder.push(new TextEncoder().encode('data: ab'))).toThrowError(
    expect.objectContaining({ code: 'EVENT_TOO_LARGE', byteOffset: 0 }),
  );
});

test('resets the event byte budget at blank boundaries without data', () => {
  const decoder = createServerSentEventDecoder({ maxEventBytes: 5 });

  expect(decoder.push(new TextEncoder().encode(': x\n\n: y\n\n'))).toEqual([]);
});

test('rejects input after the decoder is finished', () => {
  const decoder = createServerSentEventDecoder();
  decoder.finish();

  expect(() => decoder.push(Uint8Array.of())).toThrowError(
    expect.objectContaining({ code: 'DECODER_CLOSED' }),
  );
});

test('encodes multiline data into deterministic SSE fields', () => {
  const bytes = encodeServerSentEvent({
    data: 'first\nsecond',
    event: 'update',
    id: '7',
    retry: 1500,
  });

  expect(new TextDecoder().decode(bytes)).toBe(
    'event: update\nid: 7\nretry: 1500\ndata: first\ndata: second\n\n',
  );
});

test('rejects line breaks in single-line fields', () => {
  expect(() => encodeServerSentEvent({ data: 'ok', event: 'bad\nevent' })).toThrowError(
    expect.objectContaining({ code: 'INVALID_EVENT' }),
  );
});
