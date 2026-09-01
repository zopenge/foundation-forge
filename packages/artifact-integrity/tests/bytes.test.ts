import { describe, expect, test } from 'vitest';

import {
  ArtifactIntegrityError,
  calculateBytesIntegrity,
  formatSha256Digest,
  parseSha256Digest,
  verifyBytesIntegrity,
} from '../src/index.js';

const abcSha256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const bytes = new TextEncoder().encode('abc');

describe('byte integrity', () => {
  test('calculates the known SHA-256 vector with byte length', async () => {
    await expect(calculateBytesIntegrity(bytes)).resolves.toEqual({
      byteLength: 3,
      sha256: abcSha256,
    });
  });

  test('parses and formats explicitly prefixed SHA-256 digests', () => {
    expect(parseSha256Digest(`SHA256:${abcSha256.toUpperCase()}`)).toBe(abcSha256);
    expect(parseSha256Digest(abcSha256)).toBeUndefined();
    expect(parseSha256Digest('sha256:not-a-digest')).toBeUndefined();
    expect(formatSha256Digest(abcSha256.toUpperCase())).toBe(`sha256:${abcSha256}`);
  });

  test('verifies expected byte length and digest', async () => {
    await expect(verifyBytesIntegrity(bytes, { byteLength: 3, sha256: abcSha256 }))
      .resolves.toEqual({ byteLength: 3, sha256: abcSha256 });
    await expect(verifyBytesIntegrity(bytes, { byteLength: 4, sha256: abcSha256 }))
      .rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' });
  });

  test('rejects invalid expectations with a structured error', async () => {
    await expect(verifyBytesIntegrity(bytes, { byteLength: -1, sha256: 'invalid' }))
      .rejects.toBeInstanceOf(ArtifactIntegrityError);
    await expect(verifyBytesIntegrity(bytes, { byteLength: -1, sha256: 'invalid' }))
      .rejects.toMatchObject({ code: 'INVALID_EXPECTATION' });
    expect(() => formatSha256Digest('invalid')).toThrowError(
      expect.objectContaining({ code: 'INVALID_DIGEST' }),
    );
  });
});
