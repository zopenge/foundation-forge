import { expect, test } from 'vitest';

import {
  decodeZipArchive,
  encodeZipArchive,
  inspectZipArchive,
} from '../src/index.js';

test.each(['store', 'deflate'] as const)(
  'round-trips deterministic ZIP32 %s archives with sorted UTF-8 paths',
  (compression) => {
    const entries = [
      { bytes: new TextEncoder().encode('资料'), kind: 'file' as const, path: '资料/b.txt' },
      { kind: 'directory' as const, path: '资料/' },
      { bytes: Uint8Array.of(1, 2, 3), kind: 'file' as const, path: 'a.bin' },
    ];

    const first = encodeZipArchive(entries, { compression });
    const second = encodeZipArchive(entries, { compression });

    expect(first).toEqual(second);
    expect(decodeZipArchive(first).entries).toEqual([
      { bytes: Uint8Array.of(1, 2, 3), kind: 'file', path: 'a.bin' },
      { kind: 'directory', path: '资料/' },
      { bytes: new TextEncoder().encode('资料'), kind: 'file', path: '资料/b.txt' },
    ]);
  },
);

test('inspects compressed metadata and archive safety totals', () => {
  const archive = encodeZipArchive([
    { bytes: Uint8Array.of(1, 2, 3), kind: 'file', path: 'a.bin' },
    { kind: 'directory', path: 'empty/' },
  ], { compression: 'store' });

  expect(inspectZipArchive(archive)).toEqual({
    entries: [
      {
        compressedBytes: 3,
        compression: 'store',
        crc32: 1_438_416_925,
        kind: 'file',
        path: 'a.bin',
        uncompressedBytes: 3,
      },
      {
        compressedBytes: 0,
        compression: 'store',
        crc32: 0,
        kind: 'directory',
        path: 'empty/',
        uncompressedBytes: 0,
      },
    ],
    summary: { directoryCount: 1, entryCount: 2, expandedBytes: 3, fileCount: 1 },
  });
});

test('rejects declared expanded bytes above the configured limit', () => {
  const archive = encodeZipArchive([
    { bytes: new Uint8Array(32), kind: 'file', path: 'large.bin' },
  ], { compression: 'deflate' });

  expect(() => decodeZipArchive(archive, {
    limits: { maxExpandedBytes: 8 },
  })).toThrowError(expect.objectContaining({ code: 'UNSAFE_ARCHIVE' }));
});

test('rejects ZIP entries marked as symbolic links', () => {
  const archive = encodeZipArchive([
    { bytes: Uint8Array.of(1), kind: 'file', path: 'link' },
  ], { compression: 'store' }).slice();
  const centralOffset = findSignature(archive, 0x02014b50);
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  view.setUint8(centralOffset + 5, 3);
  view.setUint32(centralOffset + 38, (0o120777 << 16) >>> 0, true);

  expect(() => inspectZipArchive(archive)).toThrowError(
    expect.objectContaining({ code: 'UNSAFE_ARCHIVE' }),
  );
});

test('rejects content whose CRC no longer matches the central directory', () => {
  const archive = encodeZipArchive([
    { bytes: Uint8Array.of(1, 2, 3), kind: 'file', path: 'a.bin' },
  ], { compression: 'store' }).slice();
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const nameLength = view.getUint16(26, true);
  const extraLength = view.getUint16(28, true);
  const dataOffset = 30 + nameLength + extraLength;
  archive[dataOffset] = (archive[dataOffset] ?? 0) ^ 0xff;

  expect(() => decodeZipArchive(archive)).toThrowError(
    expect.objectContaining({ code: 'CRC_MISMATCH' }),
  );
});

test('rejects ZIP64 markers instead of guessing an archive shape', () => {
  const archive = encodeZipArchive([], { compression: 'store' }).slice();
  const endOffset = findSignature(archive, 0x06054b50);
  new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
    .setUint16(endOffset + 10, 0xffff, true);

  expect(() => inspectZipArchive(archive)).toThrowError(
    expect.objectContaining({ code: 'UNSUPPORTED_ZIP_FEATURE' }),
  );
});

test('rejects a local header whose path differs from its central directory entry', () => {
  const archive = encodeZipArchive([
    { bytes: Uint8Array.of(1), kind: 'file', path: 'a.bin' },
  ], { compression: 'store' }).slice();
  archive[30] = 'b'.charCodeAt(0);

  expect(() => inspectZipArchive(archive)).toThrowError(
    expect.objectContaining({ code: 'INVALID_ZIP' }),
  );
});

test('rejects duplicate source paths and oversized archive bytes', () => {
  expect(() => encodeZipArchive([
    { bytes: Uint8Array.of(1), kind: 'file', path: 'same' },
    { bytes: Uint8Array.of(2), kind: 'file', path: 'same' },
  ], { compression: 'store' })).toThrowError(
    expect.objectContaining({ code: 'DUPLICATE_ENTRY' }),
  );

  const archive = encodeZipArchive([], { compression: 'store' });
  expect(() => inspectZipArchive(archive, {
    limits: { maxArchiveBytes: archive.length - 1 },
  })).toThrowError(expect.objectContaining({ code: 'ARCHIVE_TOO_LARGE' }));
});

function findSignature(bytes: Uint8Array, signature: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index <= bytes.length - 4; index += 1) {
    if (view.getUint32(index, true) === signature) {
      return index;
    }
  }
  throw new Error('fixture signature not found');
}
