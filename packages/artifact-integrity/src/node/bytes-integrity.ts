import { createHash } from 'node:crypto';

import {
  artifactIntegrityErrorCodes,
  type ArtifactIntegrity,
} from '../contracts.js';
import {
  assertIntegrityMatches,
  normalizeIntegrityExpectation,
} from '../digest.js';
import { ArtifactIntegrityError } from '../errors.js';

export const calculateBytesIntegritySync = (bytes: Uint8Array): ArtifactIntegrity => {
  if (!(bytes instanceof Uint8Array)) {
    throw new ArtifactIntegrityError(artifactIntegrityErrorCodes.invalidBytes);
  }
  return {
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
};

export const verifyBytesIntegritySync = (
  bytes: Uint8Array,
  expectedValue: ArtifactIntegrity,
): ArtifactIntegrity => {
  const expected = normalizeIntegrityExpectation(expectedValue);
  const actual = calculateBytesIntegritySync(bytes);
  assertIntegrityMatches(actual, expected);
  return actual;
};
