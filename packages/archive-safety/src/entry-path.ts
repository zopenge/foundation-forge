import {
  PathSafetyError,
  validatePortableRelativePath,
} from '@openge/forge-path-safety';

import { archiveSafetyErrorCodes } from './contracts.js';
import { ArchiveSafetyError } from './errors.js';

export const validateArchiveEntryPath = (path: string): string => {
  const pathWithoutDirectorySuffix = path.endsWith('/') ? path.slice(0, -1) : path;
  try {
    validatePortableRelativePath(pathWithoutDirectorySuffix);
  } catch (error) {
    if (error instanceof PathSafetyError) {
      throw new ArchiveSafetyError(archiveSafetyErrorCodes.invalidEntryPath, { path });
    }
    throw error;
  }
  return path;
};
