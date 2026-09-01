import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';

import {
  artifactIntegrityErrorCodes,
  type ArtifactIntegrity,
  type FileIntegrityOptions,
} from '../contracts.js';
import {
  assertIntegrityMatches,
  normalizeIntegrityExpectation,
} from '../digest.js';
import { ArtifactIntegrityError } from '../errors.js';

export const calculateFileIntegrity = async (
  path: string,
  options: FileIntegrityOptions = {},
): Promise<ArtifactIntegrity> => {
  throwIfAborted(options.signal);
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    throw new ArtifactIntegrityError(artifactIntegrityErrorCodes.fileIoFailed, { path }, error);
  }
  throwIfAborted(options.signal);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new ArtifactIntegrityError(artifactIntegrityErrorCodes.nonRegularFile, { path });
  }

  const digest = createHash('sha256');
  const stream = createReadStream(path);
  let byteLength = 0;
  const abort = (): void => {
    stream.destroy(new Error(artifactIntegrityErrorCodes.operationAborted));
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of stream) {
      throwIfAborted(options.signal);
      const bytes = chunk as Buffer;
      byteLength += bytes.byteLength;
      digest.update(bytes);
    }
  } catch (error) {
    if (options.signal?.aborted === true) {
      throw new ArtifactIntegrityError(
        artifactIntegrityErrorCodes.operationAborted,
        { path },
        options.signal.reason,
      );
    }
    throw new ArtifactIntegrityError(artifactIntegrityErrorCodes.fileIoFailed, { path }, error);
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }
  throwIfAborted(options.signal);
  return { byteLength, sha256: digest.digest('hex') };
};

export const verifyFileIntegrity = async (
  path: string,
  expectedValue: ArtifactIntegrity,
  options: FileIntegrityOptions = {},
): Promise<ArtifactIntegrity> => {
  const expected = normalizeIntegrityExpectation(expectedValue);
  const actual = await calculateFileIntegrity(path, options);
  assertIntegrityMatches(actual, expected);
  return actual;
};

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true) {
    throw new ArtifactIntegrityError(
      artifactIntegrityErrorCodes.operationAborted,
      {},
      signal.reason,
    );
  }
};
