import { isAbsolute, relative } from 'node:path';

export const selectPackageTestSettings = (file, packages) => {
  if (typeof file !== 'string' || !Array.isArray(packages)) throw new Error('WORKSPACE_TEST_OWNER_INVALID');
  const owners = packages.filter(value => {
    const child = relative(value.packageRoot, file);
    return child && !child.startsWith('..') && !isAbsolute(child);
  });
  if (owners.length !== 1) throw new Error('WORKSPACE_TEST_OWNER_INVALID');
  return owners[0];
};
