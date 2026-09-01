import { execFile, spawn } from 'node:child_process';

import { repositoryFilesErrorCodes } from './contracts.js';
import { RepositoryFilesError } from './errors.js';

interface GitCommandOptions {
  readonly allowedExitCodes?: ReadonlySet<number>;
  readonly cwd: string;
  readonly input?: string;
  readonly signal?: AbortSignal;
}

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true) {
    throw new RepositoryFilesError(
      repositoryFilesErrorCodes.operationAborted,
      {},
      signal.reason,
    );
  }
};

const toRepositoryFilesError = (
  error: unknown,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal | undefined,
): RepositoryFilesError => {
  if (signal?.aborted === true || isErrorCode(error, 'ABORT_ERR')) {
    return new RepositoryFilesError(
      repositoryFilesErrorCodes.operationAborted,
      { args, cwd },
      signal?.reason ?? error,
    );
  }
  if (isErrorCode(error, 'ENOENT')) {
    return new RepositoryFilesError(repositoryFilesErrorCodes.gitUnavailable, { args, cwd }, error);
  }
  const exitCode = readNumericErrorCode(error);
  return new RepositoryFilesError(
    repositoryFilesErrorCodes.gitCommandFailed,
    exitCode === undefined ? { args, cwd } : { args, cwd, exitCode },
    error,
  );
};

export const runGitCommand = async (
  args: readonly string[],
  options: GitCommandOptions,
): Promise<string> => {
  throwIfAborted(options.signal);
  if (options.input !== undefined) {
    return runGitCommandWithInput(args, options);
  }
  return new Promise((resolvePromise, rejectPromise) => {
    execFile('git', [...args], {
      cwd: options.cwd,
      encoding: 'utf8',
      maxBuffer: 16 * 1_024 * 1_024,
      windowsHide: true,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }, (error, stdout) => {
      const exitCode = readNumericErrorCode(error);
      if (error !== null && (exitCode === undefined || !options.allowedExitCodes?.has(exitCode))) {
        rejectPromise(toRepositoryFilesError(error, args, options.cwd, options.signal));
        return;
      }
      resolvePromise(stdout);
    });
  });
};

const runGitCommandWithInput = (
  args: readonly string[],
  options: GitCommandOptions,
): Promise<string> => new Promise((resolvePromise, rejectPromise) => {
  throwIfAborted(options.signal);
  const child = spawn('git', [...args], {
    cwd: options.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let settled = false;
  const rejectOnce = (error: unknown): void => {
    if (settled) return;
    settled = true;
    rejectPromise(toRepositoryFilesError(error, args, options.cwd, options.signal));
  };
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.on('error', rejectOnce);
  child.on('close', (code) => {
    if (settled) return;
    if (code !== 0 && (code === null || !options.allowedExitCodes?.has(code))) {
      rejectOnce(Object.assign(new Error(Buffer.concat(stderr).toString('utf8').trim()), { code }));
      return;
    }
    settled = true;
    resolvePromise(Buffer.concat(stdout).toString('utf8'));
  });
  child.stdin.end(options.input, 'utf8');
});

const isErrorCode = (error: unknown, expected: string): boolean => (
  typeof error === 'object'
  && error !== null
  && 'code' in error
  && error.code === expected
);

const readNumericErrorCode = (error: unknown): number | undefined => {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'number' ? error.code : undefined;
};
