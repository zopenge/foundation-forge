import { realpath, stat } from 'node:fs/promises';
import {
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';

import { pathSafetyErrorCodes } from '../contracts.js';
import { PathSafetyError } from '../errors.js';
import { validatePortableRelativePath } from '../portable-path.js';

export const resolvePathWithinRoot = (
  rootPath: string,
  logicalPath: string,
): string => {
  const normalizedLogicalPath = validatePortableRelativePath(logicalPath);
  const root = resolve(rootPath);
  const target = resolve(root, ...normalizedLogicalPath.split('/'));
  assertContained(root, target, { logicalPath, rootPath });
  return target;
};

export const resolveExistingPathWithinRoot = async (
  rootPath: string,
  logicalPath: string,
): Promise<string> => {
  const lexicalTarget = resolvePathWithinRoot(rootPath, logicalPath);
  let root: string;
  let rootMetadata;
  try {
    root = await realpath(resolve(rootPath));
    rootMetadata = await stat(root);
  } catch (error) {
    throw new PathSafetyError(
      pathSafetyErrorCodes.pathIoFailed,
      { logicalPath, rootPath, operation: 'resolve-root' },
      error,
    );
  }
  if (!rootMetadata.isDirectory()) {
    throw new PathSafetyError(pathSafetyErrorCodes.rootNotDirectory, { rootPath });
  }

  let target: string;
  try {
    target = await realpath(lexicalTarget);
  } catch (error) {
    throw new PathSafetyError(
      pathSafetyErrorCodes.pathIoFailed,
      { logicalPath, rootPath, operation: 'resolve-target' },
      error,
    );
  }
  assertContained(root, target, { logicalPath, rootPath });
  return target;
};

const assertContained = (
  root: string,
  target: string,
  details: Readonly<Record<string, unknown>>,
): void => {
  const relativePath = relative(root, target);
  if (
    relativePath.length === 0
    || relativePath === '..'
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
  ) {
    throw new PathSafetyError(pathSafetyErrorCodes.pathEscape, {
      ...details,
      resolvedRoot: root,
      resolvedTarget: target,
    });
  }
};
