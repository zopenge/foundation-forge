import { pathSafetyErrorCodes } from './contracts.js';
import { PathSafetyError } from './errors.js';

const drivePathPattern = /^[A-Za-z]:/u;
// Unicode 模式将合法代理对视为单个码点，仅匹配孤立代理码元。
const loneSurrogatePattern = /[\uD800-\uDFFF]/u;

export const validatePortableRelativePath = (path: string): string => {
  const segments = path.split('/');
  if (
    path.length === 0
    || path.includes('\\')
    || path.includes('\0')
    || loneSurrogatePattern.test(path)
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
