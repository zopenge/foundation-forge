import { pathSafetyErrorCodes } from './contracts.js';
import { PathSafetyError } from './errors.js';

const drivePathPattern = /^[A-Za-z]:/u;

export const validatePortableRelativePath = (path: string): string => {
  const segments = path.split('/');
  if (
    path.length === 0
    || path.includes('\\')
    || path.includes('\0')
    || path.startsWith('/')
    || drivePathPattern.test(path)
    || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new PathSafetyError(pathSafetyErrorCodes.invalidRelativePath, { path });
  }
  return path;
};

export const normalizePortableRelativePath = (path: string): string => (
  validatePortableRelativePath(path.replaceAll('\\', '/'))
);
