export interface ArtifactIntegrity {
  readonly byteLength: number;
  readonly sha256: string;
}

export interface FileIntegrityOptions {
  readonly signal?: AbortSignal;
}

export const artifactIntegrityErrorCodes = {
  cryptoUnavailable: 'CRYPTO_UNAVAILABLE',
  fileIoFailed: 'FILE_IO_FAILED',
  integrityMismatch: 'INTEGRITY_MISMATCH',
  invalidBytes: 'INVALID_BYTES',
  invalidDigest: 'INVALID_DIGEST',
  invalidExpectation: 'INVALID_EXPECTATION',
  nonRegularFile: 'NON_REGULAR_FILE',
  operationAborted: 'OPERATION_ABORTED',
} as const;

export type ArtifactIntegrityErrorCode = typeof artifactIntegrityErrorCodes[
  keyof typeof artifactIntegrityErrorCodes
];
