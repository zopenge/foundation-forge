import { resolve } from 'node:path';
import type { ReleaseReport, RunReleaseOptions } from '../contracts.js';
import { assertActive, ReleaseError } from './errors.js';
import { diagnostic, readConfig, runWorkspaceRelease } from './workspace-release.js';
import { validateReleaseConfig } from './config.js';
import { runManagedRelease } from './managed-release.js';
import { pathExists } from './managed-io.js';
import { runManagedReceiptCommand } from './managed-recovery.js';
import { runManagedRetirement } from './managed-retirement.js';

export async function runRelease(options: RunReleaseOptions): Promise<ReleaseReport> {
  const startedAt = new Date().toISOString();
  try {
    assertActive(options.signal);
    if (!['check', 'publish', 'status', 'verify', 'recover', 'retire', 'login'].includes(options.command)
      || (options.sha !== undefined && (!['status', 'verify'].includes(options.command) || !/^[a-f0-9]{40}$/u.test(options.sha)))) throw new ReleaseError('ARGUMENT_INVALID');
    if (options.command === 'retire' ? !options.runId || !/^[a-f0-9-]{36}$/u.test(options.runId) || (options.confirmOrigin !== undefined && !/^[a-f0-9]{64}$/u.test(options.confirmOrigin)) : options.runId !== undefined || options.confirmOrigin !== undefined) throw new ReleaseError('ARGUMENT_INVALID');
    if (options.command === 'login') return await runWorkspaceRelease(options);
    const managed = await pathExists(resolve(options.cwd, '.tmp/forge-vercel-release/managed.json'));
    if (options.command === 'retire') {
      if (!managed) throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'RETIREMENT_REQUIRES_MANAGED_RUN' });
      return await runManagedRetirement(options);
    }
    if (['status', 'verify', 'recover'].includes(options.command) && managed) return await runManagedReceiptCommand(options);
    const config = options.config === undefined ? await readConfig(resolve(options.cwd, options.configPath ?? 'release.config.json')) : validateReleaseConfig(options.config);
    if (managed && config.source.mode === 'workspace') throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'MANAGED_ANCHOR_EXISTS' });
    return await (config.source.mode === 'managed-commit'
      ? ['status', 'verify', 'recover'].includes(options.command) ? runManagedReceiptCommand(options) : runManagedRelease(options)
      : runWorkspaceRelease(options));
  } catch (error) {
    return { schemaVersion: 2, command: options.command, ok: false, startedAt, finishedAt: new Date().toISOString(), steps: [],
      effects: { developmentPush: 'not-attempted', releasePush: 'not-attempted' }, error: diagnostic(error) };
  }
}
