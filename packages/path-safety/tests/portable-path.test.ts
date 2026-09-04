import { describe, expect, test } from 'vitest';

import {
  PathSafetyError,
  normalizePortableRelativePath,
  pathSafetyErrorCodes,
  validatePortableRelativePath,
} from '../src/index.js';

describe('portable relative paths', () => {
  test.each([
    'file.txt',
    'directory/file.txt',
    'directory/nested/file.txt',
    '资料/文件.txt',
  ])('accepts a canonical portable path: %s', (path) => {
    expect(validatePortableRelativePath(path)).toBe(path);
  });

  test.each([
    '',
    '/',
    '/absolute.txt',
    'C:drive-relative.txt',
    'C:/drive-absolute.txt',
    'C:\\drive-absolute.txt',
    '\\\\server\\share.txt',
    '\\\\?\\C:\\device.txt',
    '\\\\.\\pipe\\name',
    'directory\\file.txt',
    'directory//file.txt',
    'directory/',
    './file.txt',
    'directory/../file.txt',
    'directory/./file.txt',
    'directory/\0file.txt',
  ])('rejects a non-canonical or unsafe path: %s', (path) => {
    expect(() => validatePortableRelativePath(path)).toThrowError(
      expect.objectContaining({ code: pathSafetyErrorCodes.invalidRelativePath }),
    );
  });

  test('normalizes ordinary backslashes before validation', () => {
    expect(normalizePortableRelativePath('directory\\nested\\file.txt'))
      .toBe('directory/nested/file.txt');
  });

  test.each([
    '\\\\server\\share.txt',
    '\\\\?\\C:\\device.txt',
    '\\\\.\\pipe\\name',
  ])('does not normalize an absolute or device path into an accepted path: %s', (path) => {
    expect(() => normalizePortableRelativePath(path)).toThrowError(PathSafetyError);
  });
});

describe('UTF-16 path integrity', () => {
  test.each(['\ud800', '\udfff', 'folder/\ud801.txt', '\ud800\ud800', '\udc00\ud800'])('rejects unpaired surrogate path %j', path => {
    expect(() => validatePortableRelativePath(path)).toThrowError(expect.objectContaining({ code: pathSafetyErrorCodes.invalidRelativePath }));
    expect(() => normalizePortableRelativePath(path)).toThrowError(expect.objectContaining({ code: pathSafetyErrorCodes.invalidRelativePath }));
  });
  test('preserves paired surrogate characters through validation and normalization', () => {
    expect(validatePortableRelativePath('folder/\ud83d\ude80.txt')).toBe('folder/\ud83d\ude80.txt');
    expect(normalizePortableRelativePath('folder\\\ud83d\ude80.txt')).toBe('folder/\ud83d\ude80.txt');
  });
});
