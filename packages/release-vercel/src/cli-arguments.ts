import { resolve } from 'node:path';
import type { ReleaseCommand } from './contracts.js';
import { ReleaseError } from './node/errors.js';

export function parseArguments(args: readonly string[]): { command: ReleaseCommand; cwd: string; configPath?: string; sha?: string; runId?: string; confirmOrigin?: string; retryCompletion?: boolean; abandonUnstarted?: boolean } {
  const command = args[0];
  if (!['check', 'publish', 'status', 'verify', 'recover', 'retire', 'login'].includes(command ?? '')) throw new ReleaseError('ARGUMENT_INVALID');
  const values = new Map<string, string>();
  let retryCompletion = false;
  let abandonUnstarted = false;
  for (let index = 1; index < args.length;) {
    const flag = args[index], value = args[index + 1];
    if (flag === '--abandon-unstarted') {
      if (command !== 'retire' || abandonUnstarted) throw new ReleaseError('ARGUMENT_INVALID');
      abandonUnstarted = true; index++; continue;
    }
    if (flag === '--retry-completion') {
      if (command !== 'verify' || retryCompletion) throw new ReleaseError('ARGUMENT_INVALID');
      retryCompletion = true; index++; continue;
    }
    if (!flag || !['--cwd', '--config', '--sha', '--run-id', '--confirm-origin'].includes(flag) || values.has(flag) || !value || value.startsWith('--')) throw new ReleaseError('ARGUMENT_INVALID');
    values.set(flag, value); index += 2;
  }
  const sha = values.get('--sha');
  if (sha !== undefined && (!['status', 'verify'].includes(command ?? '') || !/^[a-f0-9]{40}$/u.test(sha))) throw new ReleaseError('ARGUMENT_INVALID');
  const configPath = values.get('--config');
  const runId = values.get('--run-id'), confirmOrigin = values.get('--confirm-origin');
  if (abandonUnstarted && confirmOrigin !== undefined) throw new ReleaseError('ARGUMENT_INVALID');
  if (command === 'retire' ? !runId || !/^[a-f0-9-]{36}$/u.test(runId) || (confirmOrigin !== undefined && !/^[a-f0-9]{64}$/u.test(confirmOrigin)) : runId !== undefined || confirmOrigin !== undefined) throw new ReleaseError('ARGUMENT_INVALID');
  return { command: command as ReleaseCommand, cwd: resolve(values.get('--cwd') ?? process.cwd()),
    ...(configPath === undefined ? {} : { configPath }), ...(sha === undefined ? {} : { sha }), ...(runId ? { runId } : {}), ...(confirmOrigin ? { confirmOrigin } : {}),
    ...(retryCompletion ? { retryCompletion: true } : {}), ...(abandonUnstarted ? { abandonUnstarted: true } : {}) };
}
