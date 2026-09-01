import {
  artifactIntegrityErrorCodes,
  type ArtifactIntegrity,
} from './contracts.js';
import { ArtifactIntegrityError } from './errors.js';

const sha256Pattern = /^[a-f0-9]{64}$/u;
const prefixedSha256Pattern = /^sha256:(?<digest>[a-f0-9]{64})$/iu;

export const parseSha256Digest = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  return value.trim().match(prefixedSha256Pattern)?.groups?.digest?.toLowerCase();
};

export const normalizeSha256Digest = (value: unknown): string => {
  if (typeof value !== 'string') {
    throw new ArtifactIntegrityError(artifactIntegrityErrorCodes.invalidDigest, {
      valueType: typeof value,
    });
  }
  const normalized = value.trim().toLowerCase();
  if (!sha256Pattern.test(normalized)) {
    throw new ArtifactIntegrityError(artifactIntegrityErrorCodes.invalidDigest);
  }
  return normalized;
};

export const formatSha256Digest = (digest: string): string => (
  `sha256:${normalizeSha256Digest(digest)}`
);

export const normalizeIntegrityExpectation = (value: ArtifactIntegrity): ArtifactIntegrity => {
  if (!Number.isSafeInteger(value.byteLength) || value.byteLength < 0) {
    throw new ArtifactIntegrityError(artifactIntegrityErrorCodes.invalidExpectation, {
      byteLength: value.byteLength,
    });
  }
  try {
    return {
      byteLength: value.byteLength,
      sha256: normalizeSha256Digest(value.sha256),
    };
  } catch (error) {
    if (error instanceof ArtifactIntegrityError) {
      throw new ArtifactIntegrityError(
        artifactIntegrityErrorCodes.invalidExpectation,
        { field: 'sha256' },
        error,
      );
    }
    throw error;
  }
};

export const assertIntegrityMatches = (
  actual: ArtifactIntegrity,
  expected: ArtifactIntegrity,
): void => {
  if (actual.byteLength !== expected.byteLength || actual.sha256 !== expected.sha256) {
    throw new ArtifactIntegrityError(artifactIntegrityErrorCodes.integrityMismatch, {
      actualByteLength: actual.byteLength,
      actualSha256: actual.sha256,
      expectedByteLength: expected.byteLength,
      expectedSha256: expected.sha256,
    });
  }
};
