import { expect, test } from 'vitest';

import {
  createJsonLinesDecoder,
  encodeJsonLine,
  parseJsonLines,
} from '../src/index.js';

test('decodes UTF-8 JSON Lines across arbitrary byte boundaries', () => {
  const bytes = new TextEncoder().encode('{"name":"资料"}\r\n{"ok":true}\n42');

  for (let split = 0; split <= bytes.length; split += 1) {
    const decoder = createJsonLinesDecoder();
    const values = [
      ...decoder.push(bytes.subarray(0, split)),
      ...decoder.push(bytes.subarray(split)),
      ...decoder.finish(),
    ];

    expect(values).toEqual([{ name: '资料' }, { ok: true }, 42]);
  }
});

test('reports invalid UTF-8 with a structured position', () => {
  const decoder = createJsonLinesDecoder();

  expect(() => decoder.push(Uint8Array.of(0xc3, 0x28, 0x0a))).toThrowError(
    expect.objectContaining({ code: 'INVALID_UTF8', line: 1, byteOffset: 0 }),
  );
});

test('enforces the configured maximum line size before a newline arrives', () => {
  const decoder = createJsonLinesDecoder({ maxLineBytes: 4 });

  expect(() => decoder.push(new TextEncoder().encode('{"a":1}'))).toThrowError(
    expect.objectContaining({ code: 'LINE_TOO_LARGE', line: 1, byteOffset: 0 }),
  );
});

test('rejects input after the decoder is finished', () => {
  const decoder = createJsonLinesDecoder();
  decoder.finish();

  expect(() => decoder.push(Uint8Array.of())).toThrowError(
    expect.objectContaining({ code: 'DECODER_CLOSED' }),
  );
});

test('parses text while ignoring whitespace-only lines', () => {
  expect(parseJsonLines(' {"a":1}\n \r\nnull\n')).toEqual([{ a: 1 }, null]);
});

test('encodes one value as UTF-8 JSON followed by LF', () => {
  expect(new TextDecoder().decode(encodeJsonLine({ text: '资料' })))
    .toBe('{"text":"资料"}\n');
});

test('rejects values that JSON cannot encode', () => {
  expect(() => encodeJsonLine(undefined)).toThrowError(
    expect.objectContaining({ code: 'UNENCODABLE_VALUE', line: 1, byteOffset: 0 }),
  );
});
