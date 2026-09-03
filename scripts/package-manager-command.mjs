import { existsSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';

export const findNpmCliPath = (pathValue = process.env.PATH ?? '') => {
  for (const directory of pathValue.split(delimiter)) {
    if (directory === '') {
      continue;
    }
    const candidate = resolve(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error('Unable to locate npm-cli.js on PATH');
};

export const createPackageManagerInvocation = (
  manager,
  args,
  {
    nodeExecutable = process.execPath,
    npmCliPath,
    platform = process.platform,
    pnpmCliPath = process.env.npm_execpath,
  } = {},
) => {
  if (platform !== 'win32') {
    return { args, command: manager };
  }

  const cliPath = manager === 'pnpm' ? pnpmCliPath : npmCliPath;
  if (typeof cliPath !== 'string' || cliPath === '') {
    throw new Error(`Unable to locate the ${manager} JavaScript CLI on Windows`);
  }
  return {
    args: [cliPath, ...args],
    command: nodeExecutable,
  };
};
