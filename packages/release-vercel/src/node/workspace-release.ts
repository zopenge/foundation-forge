import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { calculateBytesIntegrity } from '@openge/forge-artifact-integrity';
import type { ReleaseConfig, ReleaseDeployment, ReleaseDiagnostic, ReleaseReport, ReleaseStep, RunReleaseOptions } from '../contracts.js';
import { validateReleaseConfig } from './config.js';
import { assertActive, record, redact, ReleaseError } from './errors.js';
import { Execution, vercelInvocation } from './execution.js';
import { assertCandidate, assertRepository } from './git.js';
import { acquireLock, type OwnedLock } from './lock.js';
import { publishCandidate } from './publication.js';

const digest = async (value: unknown) => (await calculateBytesIntegrity(new TextEncoder().encode(JSON.stringify(value)))).sha256;
export function diagnostic(error: unknown): ReleaseDiagnostic {
  return error instanceof ReleaseError ? { code: error.code, details: error.details }
    : { code: 'IO_FAILED', details: { reason: redact(error instanceof Error ? error.message : String(error)).slice(0, 1000) } };
}
export async function readConfig(path: string): Promise<ReleaseConfig> {
  try { return validateReleaseConfig(JSON.parse(await readFile(path, 'utf8')) as unknown); }
  catch (error) { if (error instanceof ReleaseError) throw error; throw new ReleaseError('CONFIG_READ', { path }); }
}
export async function runWorkspaceRelease(options: RunReleaseOptions): Promise<ReleaseReport> {
  const startedAt = new Date().toISOString();
  const steps: ReleaseStep[] = [];
  const effects: ReleaseReport['effects'] = { developmentPush: 'not-attempted', releasePush: 'not-attempted' };
  const directory = resolve(options.cwd, '.tmp/forge-vercel-release');
  const reportPath = resolve(directory, 'latest-publish.json');
  let candidateSha: string | undefined, configSha256: string | undefined, result: ReleaseDeployment | undefined;
  let failure: ReleaseDiagnostic | undefined, releaseLock: OwnedLock | undefined;
  try {
    assertActive(options.signal);
    if (!['check', 'publish', 'status', 'verify', 'recover', 'login'].includes(options.command)
      || (options.sha !== undefined && (!['status', 'verify'].includes(options.command) || !/^[a-f0-9]{40}$/u.test(options.sha)))) {
      throw new ReleaseError('ARGUMENT_INVALID');
    }
    if (options.command === 'login') {
      const execution = new Execution(options.cwd, { limits: { commandMs: 600_000, deploymentMs: 600_000, pollMs: 5000, requestMs: 30_000, maxOutputBytes: 65_536 } }, options.signal, steps);
      const invocation = vercelInvocation(['login']);
      await execution.run('login', invocation, 'AUTH_REQUIRED', undefined, options.signal, true, options.onLoginOutput);
    } else {
      const path = resolve(options.cwd, options.configPath ?? 'release.config.json');
      const config = options.config === undefined ? await readConfig(path) : validateReleaseConfig(options.config);
      if (options.command === 'recover') throw new ReleaseError('SOURCE_UNSUPPORTED');
      configSha256 = await digest(config);
      const execution = new Execution(options.cwd, config, options.signal, steps);
      await assertRepository(execution, config);
      if (options.command === 'publish') releaseLock = await acquireLock(resolve(directory, 'publish.lock'));
      if (options.command === 'publish' || options.command === 'check') candidateSha = await assertCandidate(execution, config);
      else {
        candidateSha = options.sha;
        if (!candidateSha) {
          try {
            const previous = record(JSON.parse(await readFile(reportPath, 'utf8')) as unknown);
            if (typeof previous.candidateSha !== 'string' || !/^[a-f0-9]{40}$/u.test(previous.candidateSha)) throw new ReleaseError('DEPLOYMENT_SOURCE', { reason: 'INVALID_RECEIPT' });
            if (previous.configSha256 !== configSha256) throw new ReleaseError('DEPLOYMENT_SOURCE', { reason: 'CONFIG_CHANGED_USE_SHA' });
            candidateSha = previous.candidateSha;
          } catch (error) {
            if (record(error).code !== 'ENOENT') throw error;
            candidateSha = await execution.git(['rev-parse', 'HEAD']);
          }
        }
      }
      const assertFrozen = async () => {
        if (!['check', 'publish'].includes(options.command)) return;
        await assertRepository(execution, config);
        await assertCandidate(execution, config, candidateSha);
        const current = options.config === undefined ? await readConfig(path) : validateReleaseConfig(options.config);
        if (await digest(current) !== configSha256) throw new ReleaseError('CANDIDATE_CHANGED', { reason: 'CONFIG_CHANGED' });
      };
      result = await publishCandidate({ execution, config, sha: candidateSha, signal: options.signal, transport: options.transport, effects, assertFrozen,
        mutationGuard: async () => { await assertFrozen(); await releaseLock?.assertOwned(); }, stage: async () => {}, checkpoint: async () => {} }, options.command);
    }
  } catch (error) { failure = diagnostic(error); }
  const buildReport = (): ReleaseReport => ({ schemaVersion: 2, command: options.command, ok: failure === undefined,
    startedAt, finishedAt: new Date().toISOString(), steps, effects,
    ...(candidateSha === undefined ? {} : { candidateSha }), ...(configSha256 === undefined ? {} : { configSha256 }),
    ...(result === undefined ? {} : { deployment: result }), ...(failure === undefined ? {} : { error: failure }),
    ...(candidateSha === undefined || options.command !== 'publish' ? {} : {
      recovery: { candidateSha, nextCommand: ['pushed', 'already-current'].includes(effects.releasePush)
        ? `forge-vercel-release verify --sha ${candidateSha}` : 'forge-vercel-release publish', reportPath } }) });
  try {
    if (releaseLock && candidateSha) {
      await releaseLock.assertOwned();
      await mkdir(directory, { recursive: true });
      const next = resolve(directory, `report-${String(process.pid)}.json`);
      await writeFile(next, `${JSON.stringify(buildReport(), null, 2)}\n`, 'utf8'); await rename(next, reportPath);
    }
  } catch (error) { failure ??= diagnostic(error); }
  finally {
    if (releaseLock) {
      try { await releaseLock.release(); } catch (error) { failure = diagnostic(error); }
    }
  }
  return buildReport();
}
