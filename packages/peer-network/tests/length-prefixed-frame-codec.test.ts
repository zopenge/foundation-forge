import { describe, expect, test } from 'vitest';

import {
  PeerNetworkError,
  createLengthPrefixedFrameCodec,
} from '../src/index.js';

describe('length-prefixed framing', () => {
  test('reassembles fragmented frames and preserves message order', () => {
    const codec = createLengthPrefixedFrameCodec({ maxMessageBytes: 16 });
    const first = codec.encode(Uint8Array.from([1, 2]));
    const second = codec.encode(Uint8Array.from([3]));
    const combined = Uint8Array.from([...first, ...second]);

    expect(codec.decode(combined.slice(0, 5))).toEqual([]);
    expect(codec.decode(combined.slice(5))).toEqual([
      Uint8Array.from([1, 2]),
      Uint8Array.from([3]),
    ]);
  });

  test('rejects outbound messages larger than the configured limit', () => {
    const codec = createLengthPrefixedFrameCodec({ maxMessageBytes: 2 });

    expect(() => codec.encode(Uint8Array.from([1, 2, 3]))).toThrowError(
      expect.objectContaining<Partial<PeerNetworkError>>({
        code: 'message-too-large',
      }),
    );
  });

  test('rejects oversized inbound declarations before buffering payloads', () => {
    const codec = createLengthPrefixedFrameCodec({ maxMessageBytes: 2 });
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, 3);

    expect(() => codec.decode(header)).toThrowError(
      expect.objectContaining<Partial<PeerNetworkError>>({
        code: 'message-too-large',
      }),
    );
  });
});
