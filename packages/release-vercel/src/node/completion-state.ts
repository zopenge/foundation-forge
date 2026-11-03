import type { PrebuiltReleaseState, ReleaseCompletionContext, ReleaseCompletionState } from '../contracts.js';
import { releaseErrorCodes } from '../contracts.js';
import type { FrozenSource } from './release-context.js';
import { record, ReleaseError } from './errors.js';
import { candidateId, candidateOrigin } from './prebuilt-vercel.js';
import { prebuiltCandidateContext, versionAliasOrigin } from './version-alias.js';

const uuid = /^[a-f0-9-]{36}$/u;
function fail(): never { throw new ReleaseError('SLOT_STATE', { reason: 'COMPLETION_BINDING' }); }
const date = (value: unknown): boolean => typeof value === 'string' && Number.isFinite(Date.parse(value));
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const input = record(value);
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(key => !(key in input))
    || Object.keys(input).some(key => !required.includes(key) && !optional.includes(key))) fail();
  return input;
}
function error(value: unknown): void {
  const input = object(value, ['code', 'details']);
  if (!releaseErrorCodes.some(code => code === input.code) || !input.details || typeof input.details !== 'object'
    || Array.isArray(input.details) || Buffer.byteLength(JSON.stringify(input)) > 4096) fail();
}
function progress(input: Record<string, unknown>): void {
  if (!['running', 'failed', 'unknown', 'completed'].includes(String(input.status)) || !date(input.startedAt)) fail();
  if (input.status === 'running') {
    if (input.finishedAt !== undefined || input.durationMs !== undefined || input.error !== undefined) fail();
  } else {
    if (!date(input.finishedAt) || typeof input.durationMs !== 'number' || !Number.isFinite(input.durationMs) || input.durationMs < 0) fail();
    if (input.status === 'completed') { if (input.error !== undefined) fail(); }
    else error(input.error);
  }
}
function context(source: FrozenSource, prebuilt: PrebuiltReleaseState): ReleaseCompletionContext {
  if (!source.config.completion || !source.config.delivery || prebuilt.sourceSha !== source.sha
    || prebuilt.configSha256 !== source.configSha256 || prebuilt.promoteEffect === 'not-attempted') fail();
  const versionUrl = versionAliasOrigin(source.config, source.sha);
  try {
    return { teamId: source.config.vercel.teamId, projectId: source.config.vercel.projectId,
      productionUrl: new URL(source.config.vercel.productionUrl).origin, candidateUrl: candidateOrigin(prebuilt.deploymentUrl),
      sourceSha: source.sha, configSha256: source.configSha256, artifactSha256: prebuilt.artifactSha256,
      deploymentId: candidateId(prebuilt.deploymentId), ...(versionUrl ? { versionUrl } : {}) };
  } catch { return fail(); }
}

/** 这里只记录已发生 promotion 意图的精确目标，不把意图当生产或业务完成证明。 */
export function createCompletionState(source: FrozenSource, prebuilt: PrebuiltReleaseState, publicationRunId: string): ReleaseCompletionState {
  const state: ReleaseCompletionState = { schemaVersion: 1, publicationRunId, context: context(source, prebuilt), status: 'not-started', attempts: [] };
  parseCompletionState(state, source, prebuilt); return state;
}
export function parseCompletionState(value: unknown, source: FrozenSource, prebuilt: PrebuiltReleaseState | undefined): ReleaseCompletionState | undefined {
  if (value === undefined) {
    if (source.config.completion && prebuilt && prebuilt.promoteEffect !== 'not-attempted') fail();
    return;
  }
  if (!prebuilt) return fail();
  const input = object(value, ['schemaVersion', 'publicationRunId', 'context', 'status', 'attempts']);
  const expected = context(source, prebuilt), provided = record(input.context);
  if (input.schemaVersion !== 1 || typeof input.publicationRunId !== 'string' || !uuid.test(input.publicationRunId)
    || Object.keys(provided).length !== Object.keys(expected).length || Object.entries(expected).some(([key, value]) => provided[key] !== value)
    || !Array.isArray(input.attempts) || input.attempts.length > 32) fail();
  const attempts = input.attempts as unknown[];
  if (attempts.length === 0) { if (input.status !== 'not-started') fail(); }
  else if (input.status !== record(attempts.at(-1)).status && !(input.status === 'unknown' && record(attempts.at(-1)).status === 'running')) fail();
  const runs = new Set<string>(), count = source.config.completion?.jobs.length ?? 0;
  for (const [position, value] of attempts.entries()) {
    const attempt = object(value, ['runId', 'status', 'startedAt', 'jobs'], ['finishedAt', 'durationMs', 'error']); progress(attempt);
    if (typeof attempt.runId !== 'string' || !uuid.test(attempt.runId) || runs.has(attempt.runId)
      || !Array.isArray(attempt.jobs) || attempt.jobs.length > count || (position < attempts.length - 1 && attempt.status === 'completed')) fail();
    runs.add(attempt.runId);
    const jobs = attempt.jobs as unknown[];
    for (const [index, value] of jobs.entries()) {
      const job = object(value, ['index', 'status', 'startedAt'], ['commandId', 'finishedAt', 'durationMs', 'error']); progress(job);
      if (job.index !== index || (job.commandId !== undefined && (typeof job.commandId !== 'string' || !uuid.test(job.commandId)))
        || (job.status === 'completed' && job.commandId === undefined) || (index < jobs.length - 1 && job.status !== 'completed')) fail();
    }
    if (attempt.status === 'completed' && (jobs.length !== count || jobs.some(value => record(value).status !== 'completed'))) fail();
  }
  return value as ReleaseCompletionState;
}

/** 原监督器最后合并这些值；继承环境和调用方提供的同名值都不能冒充生产目标。 */
export function protectedCompletionEnvironment(source: FrozenSource, prebuilt: PrebuiltReleaseState | undefined,
  completion: ReleaseCompletionState | undefined, name: string): Readonly<Record<string, string>> {
  if (!/^(?:completion:|admission:completion:)\d+$/u.test(name)) return { FORGE_RELEASE_COMPLETION_CONTEXT: '' };
  const state = parseCompletionState(completion, source, prebuilt);
  if (!state || prebuilt?.promoteEffect !== 'accepted' || !prebuilt.promotionVerified)
    throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'COMPLETION_PRODUCTION_UNPROVEN' });
  const target = state.context;
  return { FORGE_RELEASE_COMPLETION_CONTEXT: JSON.stringify(target), FORGE_RELEASE_URL: target.productionUrl,
    FORGE_RELEASE_PHASE: 'completion', FORGE_RELEASE_DEPLOYMENT_ID: target.deploymentId,
    FORGE_RELEASE_ARTIFACT_SHA256: target.artifactSha256, FORGE_RELEASE_CONFIG_SHA256: target.configSha256,
    FORGE_RELEASE_TEAM_ID: target.teamId, FORGE_RELEASE_PROJECT_ID: target.projectId,
    FORGE_RELEASE_SERIALIZATION_SCOPE: source.config.delivery?.concurrencyControl.scope ?? '',
    FORGE_RELEASE_VERSION_URL: target.versionUrl ?? '',
    FORGE_RELEASE_CANDIDATE_CONTEXT: target.versionUrl ? JSON.stringify(prebuiltCandidateContext(source.config, prebuilt)) : '' };
}

/** 对外观察可标出已中断的 running；原始 attempt 仍保持原字节和结果。 */
export function observedCompletionState(value: ReleaseCompletionState | undefined, activeRunId: string | undefined,
  owner: 'active' | 'inactive' | 'unknown'): ReleaseCompletionState | undefined {
  if (!value || value.status !== 'running' || (owner === 'active' && value.attempts.at(-1)?.runId === activeRunId)) return value;
  return { ...value, status: 'unknown' };
}
