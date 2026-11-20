import { resolve } from 'node:path';
import type { ReleaseReport, RunReleaseOptions } from '../contracts.js';
import { assertActive, record, ReleaseError } from './errors.js';
import { diagnostic, readConfig, runWorkspaceRelease } from './workspace-release.js';
import { validateReleaseConfig } from './config.js';
import { runManagedRelease } from './managed-release.js';
import { pathExists } from './managed-io.js';
import { runManagedReceiptCommand } from './managed-recovery.js';
import { runManagedRetirement } from './managed-retirement.js';
import { createCandidateMarkerHeaders } from './candidate-marker-auth.js';

export async function runRelease(options: RunReleaseOptions): Promise<ReleaseReport> {
  const startedAt = new Date().toISOString();
  try {
    assertActive(options.signal);
    if (!['check', 'publish', 'status', 'verify', 'recover', 'retire', 'login'].includes(options.command)
      || (options.sha !== undefined && (!['status', 'verify'].includes(options.command) || !/^[a-f0-9]{40}$/u.test(options.sha)))) throw new ReleaseError('ARGUMENT_INVALID');
    if (options.retryCompletion !== undefined && (options.command !== 'verify' || typeof options.retryCompletion !== 'boolean')) throw new ReleaseError('ARGUMENT_INVALID');
    if (options.resumePrebuilt !== undefined) {
      const binding = record(options.resumePrebuilt);
      if (options.command !== 'publish' || typeof binding.runId !== 'string' || !/^[a-f0-9-]{36}$/u.test(binding.runId)
        || typeof binding.sha !== 'string' || !/^[a-f0-9]{40}$/u.test(binding.sha)
        || typeof binding.configSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(binding.configSha256)
        || typeof binding.artifactSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(binding.artifactSha256)
        || typeof binding.deploymentId !== 'string' || !/^dpl_[a-zA-Z0-9]{1,120}$/u.test(binding.deploymentId))
        throw new ReleaseError('ARGUMENT_INVALID', { field: 'resumePrebuilt' });
    }
    if (options.vercelApiHttp !== undefined && (options.transport !== undefined || !['direct', 'proxy'].includes(options.vercelApiHttp?.route)))
      throw new ReleaseError('ARGUMENT_INVALID', { field: 'vercelApiHttp' });
    if (options.discardCheckout !== undefined && (options.command !== 'recover' || typeof options.discardCheckout !== 'boolean')) throw new ReleaseError('ARGUMENT_INVALID');
    if (options.command === 'retire' || options.discardCheckout ? !options.runId || !/^[a-f0-9-]{36}$/u.test(options.runId) : options.runId !== undefined)
      throw new ReleaseError('ARGUMENT_INVALID');
    const resolveMarkerAuth = options.candidateMarkerAuth;
    if (resolveMarkerAuth !== undefined && (typeof resolveMarkerAuth !== 'function' || options.transport !== undefined))
      throw new ReleaseError('ARGUMENT_INVALID', { field: 'candidateMarkerAuth' });
    const markerHeaders = resolveMarkerAuth && createCandidateMarkerHeaders(resolveMarkerAuth);
    if (options.command === 'login') return await runWorkspaceRelease(options);
    const managed = await pathExists(resolve(options.cwd, 'state/forge-vercel-release/managed.json'));
    if (options.resumePrebuilt && !managed) throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'PREBUILT_RESUME_REQUIRES_MANAGED_RUN' });
    if (options.command === 'retire') {
      if (!managed) throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'RETIREMENT_REQUIRES_MANAGED_RUN' });
      return await runManagedRetirement(options);
    }
    if (options.discardCheckout && !managed) throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'ISOLATION_REQUIRES_MANAGED_RUN' });
    if (['status', 'verify', 'recover'].includes(options.command) && managed) return await runManagedReceiptCommand(options, markerHeaders);
    const config = options.config === undefined ? await readConfig(resolve(options.cwd, options.configPath ?? 'release.config.json')) : validateReleaseConfig(options.config);
    if (options.retryCompletion && !config.completion) throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'COMPLETION_NOT_CONFIGURED' });
    if (managed && config.source.mode === 'workspace') throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'MANAGED_ANCHOR_EXISTS' });
    return await (config.source.mode === 'managed-commit'
      ? ['status', 'verify', 'recover'].includes(options.command) ? runManagedReceiptCommand(options, markerHeaders) : runManagedRelease(options, markerHeaders)
      : runWorkspaceRelease(options));
  } catch (error) {
    return { schemaVersion: 2, command: options.command, ok: false, startedAt, finishedAt: new Date().toISOString(), steps: [],
      effects: { developmentPush: 'not-attempted', releasePush: 'not-attempted' }, error: diagnostic(error) };
  }
}
