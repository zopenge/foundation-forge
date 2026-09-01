import { describe, expect, test } from 'vitest';

import {
  ArchiveSafetyError,
  inspectArchiveEntries,
  validateArchiveEntryPath,
} from '../src/index.js';

describe('archive entry paths', () => {
  test.each([
    'directory/file.txt',
    'directory/nested/',
    'file.txt',
    '资料/文件.txt',
  ])('accepts a portable relative path: %s', (path) => {
    expect(validateArchiveEntryPath(path)).toBe(path);
  });

  test.each([
    '',
    '/',
    '/absolute.txt',
    'C:/drive.txt',
    'C:\\drive.txt',
    '\\\\server\\share.txt',
    'directory\\file.txt',
    'directory//file.txt',
    './file.txt',
    'directory/../file.txt',
    'directory/./file.txt',
    'directory/\0file.txt',
  ])('rejects an unsafe path: %s', (path) => {
    expect(() => validateArchiveEntryPath(path)).toThrowError(
      expect.objectContaining({ code: 'INVALID_ENTRY_PATH' }),
    );
  });
});

describe('archive entry inspection', () => {
  test('returns deterministic counts and expanded bytes', () => {
    expect(inspectArchiveEntries([
      { path: 'root/', kind: 'directory' },
      { path: 'root/a.bin', kind: 'file', uncompressedBytes: 3 },
      { path: 'root/b.bin', kind: 'file', uncompressedBytes: 5 },
    ])).toEqual({
      directoryCount: 1,
      entryCount: 3,
      expandedBytes: 8,
      fileCount: 2,
    });
  });

  test.each(['symbolic-link', 'hard-link', 'other'] as const)(
    'rejects unsupported %s entries',
    (kind) => {
      expect(() => inspectArchiveEntries([{ path: 'entry', kind }]))
        .toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_ENTRY_KIND' }));
    },
  );

  test('rejects invalid uncompressed sizes', () => {
    expect(() => inspectArchiveEntries([
      { path: 'entry.bin', kind: 'file', uncompressedBytes: -1 },
    ])).toThrowError(expect.objectContaining({ code: 'INVALID_ENTRY_SIZE' }));
    expect(() => inspectArchiveEntries([
      { path: 'entry.bin', kind: 'file' },
    ])).toThrowError(expect.objectContaining({ code: 'INVALID_ENTRY_SIZE' }));
  });

  test('enforces entry and expanded-byte limits', () => {
    const entries = [
      { path: 'a.bin', kind: 'file', uncompressedBytes: 3 },
      { path: 'b.bin', kind: 'file', uncompressedBytes: 4 },
    ] as const;

    expect(() => inspectArchiveEntries(entries, { maxEntries: 1, maxExpandedBytes: 10 }))
      .toThrowError(expect.objectContaining({ code: 'ENTRY_LIMIT_EXCEEDED' }));
    expect(() => inspectArchiveEntries(entries, { maxEntries: 2, maxExpandedBytes: 6 }))
      .toThrowError(expect.objectContaining({ code: 'EXPANDED_SIZE_LIMIT_EXCEEDED' }));
  });

  test('rejects invalid limits with a structured error', () => {
    try {
      inspectArchiveEntries([], { maxEntries: 0, maxExpandedBytes: 1 });
      throw new Error('expected validation failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ArchiveSafetyError);
      expect(error).toMatchObject({ code: 'INVALID_LIMITS' });
    }
  });
});
