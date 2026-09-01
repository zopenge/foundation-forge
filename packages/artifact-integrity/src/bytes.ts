import {
  artifactIntegrityErrorCodes,
  type ArtifactIntegrity,
} from './contracts.js';
import {
  assertIntegrityMatches,
  normalizeIntegrityExpectation,
} from './digest.js';
import { ArtifactIntegrityError } from './errors.js';

export const calculateBytesIntegrity = async (bytes: Uint8Array): Promise<ArtifactIntegrity> => {
  if (!(bytes instanceof Uint8Array)) {
    throw new ArtifactIntegrityError(artifactIntegrityErrorCodes.invalidBytes);
  }
  if (globalThis.crypto?.subtle === undefined) {
    throw new ArtifactIntegrityError(artifactIntegrityErrorCodes.cryptoUnavailable);
  }
  const input = Uint8Array.from(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', input);
  return {
    byteLength: bytes.byteLength,
    sha256: toHex(new Uint8Array(digest)),
  };
};

export const verifyBytesIntegrity = async (
  bytes: Uint8Array,
  expectedValue: ArtifactIntegrity,
): Promise<ArtifactIntegrity> => {
  const expected = normalizeIntegrityExpectation(expectedValue);
  const actual = await calculateBytesIntegrity(bytes);
  assertIntegrityMatches(actual, expected);
  return actual;
};

const toHex = (bytes: Uint8Array): string => (
  [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
);
