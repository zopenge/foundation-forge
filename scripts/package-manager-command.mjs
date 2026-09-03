import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, resolve, win32 } from 'node:path';

export const extractPnpmCliPathFromWindowsShim = (contents, shimDirectory) => {
  const match = contents.match(/%~dp0([^"\r\n]*?pnpm\.cjs)/iu);
  return match === null ? undefined : win32.join(shimDirectory, match[1]);
};

export const findPnpmCliPath = ({
  npmExecPath = process.env.npm_execpath,
  pathValue = process.env.PATH ?? '',
  pnpmHome = process.env.PNPM_HOME,
} = {}) => {
  if (typeof npmExecPath === 'string' && npmExecPath !== '' && existsSync(npmExecPath)) {
    return npmExecPath;
  }

  const shimPaths = [];
  if (typeof pnpmHome === 'string' && pnpmHome !== '') {
    shimPaths.push(resolve(pnpmHome, 'pnpm.cmd'));
  }
  for (const directory of pathValue.split(delimiter)) {
    if (directory !== '') {
      shimPaths.push(resolve(directory, 'pnpm.cmd'));
    }
  }

  for (const shimPath of new Set(shimPaths)) {
    if (!existsSync(shimPath)) {
      continue;
    }
    const cliPath = extractPnpmCliPathFromWindowsShim(
      readFileSync(shimPath, 'utf8'),
      dirname(shimPath),
    );
    if (cliPath !== undefined && existsSync(cliPath)) {
      return cliPath;
    }
  }

  throw new Error('Unable to locate the pnpm JavaScript CLI on Windows');
};

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
    pnpmCliPath,
  } = {},
) => {
  if (platform !== 'win32') {
    return { args, command: manager };
  }

  const cliPath = manager === 'pnpm'
    ? pnpmCliPath ?? findPnpmCliPath()
    : npmCliPath;
  if (typeof cliPath !== 'string' || cliPath === '') {
    throw new Error(`Unable to locate the ${manager} JavaScript CLI on Windows`);
  }
  return {
    args: [cliPath, ...args],
    command: nodeExecutable,
  };
};
