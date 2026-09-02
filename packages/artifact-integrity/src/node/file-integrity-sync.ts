import { createHash } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs';

import {
  artifactIntegrityErrorCodes,
  type ArtifactIntegrity,
} from '../contracts.js';
import {
  assertIntegrityMatches,
  normalizeIntegrityExpectation,
} from '../digest.js';
import { ArtifactIntegrityError } from '../errors.js';

const readBufferBytes = 64 * 1_024;

export const calculateFileIntegritySync = (path: string): ArtifactIntegrity => {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    throw new ArtifactIntegrityError(artifactIntegrityErrorCodes.fileIoFailed, { path }, error);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new ArtifactIntegrityError(artifactIntegrityErrorCodes.nonRegularFile, { path });
  }

  let descriptor: number | undefined;
  let failure: unknown;
  let result: ArtifactIntegrity | undefined;
  try {
    descriptor = openSync(path, 'r');
    if (!fstatSync(descriptor).isFile()) {
      throw new ArtifactIntegrityError(artifactIntegrityErrorCodes.nonRegularFile, { path });
    }
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(readBufferBytes);
    let byteLength = 0;
    let bytesRead: number;
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (bytesRead > 0) {
        digest.update(buffer.subarray(0, bytesRead));
        byteLength += bytesRead;
      }
    } while (bytesRead > 0);
    result = { byteLength, sha256: digest.digest('hex') };
  } catch (error) {
    failure = error;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch (error) {
        failure ??= error;
      }
    }
  }

  if (failure !== undefined) {
    if (failure instanceof ArtifactIntegrityError) throw failure;
    throw new ArtifactIntegrityError(artifactIntegrityErrorCodes.fileIoFailed, { path }, failure);
  }
  if (result === undefined) {
    throw new ArtifactIntegrityError(artifactIntegrityErrorCodes.fileIoFailed, { path });
  }
  return result;
};

export const verifyFileIntegritySync = (
  path: string,
  expectedValue: ArtifactIntegrity,
): ArtifactIntegrity => {
  const expected = normalizeIntegrityExpectation(expectedValue);
  const actual = calculateFileIntegritySync(path);
  assertIntegrityMatches(actual, expected);
  return actual;
};
