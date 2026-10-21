import { resolve } from 'node:path';
import type { ReleaseCommand } from './contracts.js';
import { ReleaseError } from './node/errors.js';

export function parseArguments(args: readonly string[]): { command: ReleaseCommand; cwd: string; configPath?: string; sha?: string } {
  const command = args[0];
  if (!['check', 'publish', 'status', 'verify', 'login'].includes(command ?? '')) throw new ReleaseError('ARGUMENT_INVALID');
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!flag || !['--cwd', '--config', '--sha'].includes(flag) || values.has(flag) || !value || value.startsWith('--')) throw new ReleaseError('ARGUMENT_INVALID');
    values.set(flag, value);
  }
  const sha = values.get('--sha');
  if (sha !== undefined && (!['status', 'verify'].includes(command ?? '') || !/^[a-f0-9]{40}$/u.test(sha))) throw new ReleaseError('ARGUMENT_INVALID');
  const configPath = values.get('--config');
  return { command: command as ReleaseCommand, cwd: resolve(values.get('--cwd') ?? process.cwd()),
    ...(configPath === undefined ? {} : { configPath }), ...(sha === undefined ? {} : { sha }) };
}
