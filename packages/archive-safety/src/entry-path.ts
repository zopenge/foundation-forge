import { archiveSafetyErrorCodes } from './contracts.js';
import { ArchiveSafetyError } from './errors.js';

export const validateArchiveEntryPath = (path: string): string => {
  const pathWithoutDirectorySuffix = path.endsWith('/') ? path.slice(0, -1) : path;
  const segments = pathWithoutDirectorySuffix.split('/');
  if (
    pathWithoutDirectorySuffix.length === 0
    || path.includes('\\')
    || path.includes('\0')
    || path.startsWith('/')
    || /^[A-Za-z]:/u.test(path)
    || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new ArchiveSafetyError(archiveSafetyErrorCodes.invalidEntryPath, { path });
  }
  return path;
};
