import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SourceSnapshotError } from '../errors.js';
const exec = promisify(execFile);
export const runGit = async (root: string, args: readonly string[], options: { readonly allowExitCodes?: ReadonlySet<number>; readonly signal?: AbortSignal } = {}): Promise<string> => {
  try {
    const result = await exec('git', ['--no-optional-locks', '-c', 'core.quotepath=false', '-C', root, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true, ...(options.signal === undefined ? {} : { signal: options.signal }) });
    return result.stdout;
  } catch (error) {
    const value = error as NodeJS.ErrnoException & { readonly code?: string | number; readonly stdout?: string; readonly stderr?: string };
    const exitCode = typeof value.code === 'number' ? value.code : null;
    if (exitCode !== null && options.allowExitCodes?.has(exitCode) === true) return value.stdout ?? '';
    if (value.code === 'ENOENT') throw new SourceSnapshotError('GIT_UNAVAILABLE');
    throw new SourceSnapshotError('GIT_COMMAND_FAILED', { root, args: [...args], exitCode, stderr: (value.stderr ?? '').trim().slice(0, 2048) });
  }
};
