import { setTimeout as delay } from 'node:timers/promises';
import type { PrebuiltReleaseState, ReleaseConfig, ReleaseDeployment, ReleaseTransport, VersionAliasAssignment, VersionAliasBinding, VersionAliasTransport } from '../contracts.js';
import { assertActive, record, ReleaseError } from './errors.js';
import type { Execution } from './execution.js';
import { matchesPrebuiltMarker, prebuiltMarkerPath } from './prebuilt-artifact.js';
import { createTransport, request } from './vercel.js';
import { prebuiltApiOnce } from './prebuilt-http.js';
import { versionAliasOrigin } from './version-alias.js';

const idPattern = /^dpl_[a-zA-Z0-9]{1,120}$/u;
export function candidateId(value: unknown): string {
  if (typeof value !== 'string' || !idPattern.test(value)) throw new ReleaseError('DEPLOYMENT_SOURCE', { reason: 'DEPLOYMENT_ID' });
  return value;
}
export function candidateOrigin(value: unknown): string {
  if (typeof value !== 'string') throw new ReleaseError('DEPLOYMENT_SOURCE');
  let parsed: URL; try { parsed = new URL(value.startsWith('https://') ? value : `https://${value}`); } catch { throw new ReleaseError('DEPLOYMENT_SOURCE'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.pathname !== '/'
    || parsed.search || parsed.hash || !/^[a-zA-Z0-9-]+\.vercel\.app$/u.test(parsed.hostname)) throw new ReleaseError('DEPLOYMENT_SOURCE', { reason: 'DEPLOYMENT_URL' });
  return parsed.origin;
}

/** 单次公开 API 写入；固定 CLI 的 promote 内部会重试 POST，不能用于未决效果协议。 */
export async function promotePrebuiltOnce(config: ReleaseConfig, deploymentId: string, signal: AbortSignal): Promise<void> {
  const path = `/v10/projects/${encodeURIComponent(config.vercel.projectId)}/promote/${candidateId(deploymentId)}?teamId=${encodeURIComponent(config.vercel.teamId)}`;
  await prebuiltApiOnce(config, path, 'POST', '{}', signal);
}
function aliasHostname(config: ReleaseConfig, hostname: string): string {
  const sha = /-([a-f0-9]{40})\.vercel\.app$/u.exec(hostname)?.[1];
  if (!sha || versionAliasOrigin(config, sha) !== `https://${hostname}`) throw new ReleaseError('CONFIG_INVALID', { field: 'delivery.versionAlias' });
  return encodeURIComponent(hostname);
}
function jsonBody(body: Buffer): Record<string, unknown> {
  try { return record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown); }
  catch { throw new ReleaseError('VERCEL_API', { reason: 'INVALID_JSON' }); }
}
export async function readPrebuiltVersionAlias(config: ReleaseConfig, hostname: string, signal: AbortSignal): Promise<VersionAliasBinding | undefined> {
  const path = `/v4/aliases/${aliasHostname(config, hostname)}?teamId=${encodeURIComponent(config.vercel.teamId)}`;
  const response = await prebuiltApiOnce(config, path, 'GET', '', signal, true);
  if (response.status === 404) return;
  const value = jsonBody(response.body);
  if (value.alias !== hostname || typeof value.projectId !== 'string' || typeof value.deploymentId !== 'string'
    || value.redirect != null || value.microfrontends != null || value.deletedAt != null)
    throw new ReleaseError('VERSION_ALIAS_CONFLICT', { reason: 'DIRECT_BINDING_UNCONFIRMED' });
  return { alias: hostname, projectId: value.projectId, deploymentId: value.deploymentId, routing: 'direct' };
}
export async function assignPrebuiltVersionAliasOnce(config: ReleaseConfig, deploymentId: string, hostname: string,
  signal: AbortSignal): Promise<VersionAliasAssignment> {
  aliasHostname(config, hostname);
  const path = `/v2/deployments/${candidateId(deploymentId)}/aliases?teamId=${encodeURIComponent(config.vercel.teamId)}`;
  const response = await prebuiltApiOnce(config, path, 'POST', JSON.stringify({ alias: hostname }), signal);
  const value = jsonBody(response.body);
  if (value.alias !== hostname || typeof value.uid !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(value.uid)
    || (value.oldDeploymentId !== undefined && typeof value.oldDeploymentId !== 'string'))
    throw new ReleaseError('VERCEL_API', { reason: 'VERSION_ALIAS_RESPONSE' });
  return { alias: hostname, uid: value.uid, ...(typeof value.oldDeploymentId === 'string' ? { oldDeploymentId: value.oldDeploymentId } : {}) };
}
export function createPrebuiltTransport(execution: Execution, config: ReleaseConfig, writing: boolean): ReleaseTransport {
  if (writing && !process.env.VERCEL_TOKEN) throw new ReleaseError('AUTH_REQUIRED', { reason: 'PREBUILT_TOKEN_REQUIRED' });
  let versionAlias: VersionAliasTransport | undefined;
  if (config.delivery?.versionAlias) versionAlias = { read: (hostname, signal) => readPrebuiltVersionAlias(config, hostname, signal),
    ...(writing ? { assign: (id: string, hostname: string, signal: AbortSignal) => assignPrebuiltVersionAliasOnce(config, id, hostname, signal) } : {}) };
  return { ...createTransport(execution), promote: (id, signal) => promotePrebuiltOnce(config, id, signal), ...(versionAlias ? { versionAlias } : {}) };
}
export class PrebuiltVerification {
  constructor(readonly config: ReleaseConfig, readonly transport: ReleaseTransport, readonly signal?: AbortSignal) {}
  private requestMs(deadline?: number): number {
    const remaining = deadline === undefined ? this.config.limits.requestMs : deadline - Date.now();
    if (remaining <= 0) throw new ReleaseError('DEPLOYMENT_TIMEOUT');
    return Math.min(this.config.limits.requestMs, remaining);
  }
  private async pause(remaining: number): Promise<void> {
    try { await delay(Math.min(this.config.limits.pollMs, remaining), undefined, this.signal ? { signal: this.signal } : {}); }
    catch (error) { assertActive(this.signal); throw error; }
  }
  api(path: string, deadline?: number): Promise<unknown> {
    return request(signal => this.transport.api(`${path}${path.includes('?') ? '&' : '?'}teamId=${encodeURIComponent(this.config.vercel.teamId)}`, signal), this.requestMs(deadline), this.signal);
  }
  async project(deadline?: number, allowPending = false): Promise<Record<string, unknown>> {
    const project = record(await this.api(`/v9/projects/${encodeURIComponent(this.config.vercel.projectId)}`, deadline));
    if (project.id !== this.config.vercel.projectId || project.accountId !== this.config.vercel.teamId || project.link != null) {
      throw new ReleaseError('DEPLOYMENT_SOURCE', { reason: 'PREBUILT_PROJECT' });
    }
    if (project.rollingRelease) throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'ROLLING_RELEASE_UNSUPPORTED' });
    if (project.rootDirectory != null && !['', '.'].includes(String(project.rootDirectory))) {
      throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'PREBUILT_PROJECT_ROOT' });
    }
    if (!allowPending && ['pending', 'in-progress'].includes(String(record(project.lastAliasRequest).jobStatus))) {
      throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'PROMOTION_IN_PROGRESS' });
    }
    return project;
  }
  async candidate(state: PrebuiltReleaseState, deadline?: number): Promise<ReleaseDeployment> {
    const id = candidateId(state.deploymentId), value = record(await this.api(`/v13/deployments/${id}`, deadline));
    if (value.id !== id || value.projectId !== this.config.vercel.projectId || value.ownerId !== this.config.vercel.teamId
      || value.target !== 'production' || value.source !== 'cli') throw new ReleaseError('DEPLOYMENT_SOURCE', { reason: 'PREBUILT_CANDIDATE' });
    const origin = candidateOrigin(value.url);
    if (state.deploymentUrl && origin !== state.deploymentUrl) throw new ReleaseError('DEPLOYMENT_SOURCE', { reason: 'CANDIDATE_URL_CHANGED' });
    return { id, sha: state.sourceSha, projectId: this.config.vercel.projectId, state: String(value.readyState), url: origin };
  }
  async marker(state: PrebuiltReleaseState, origin: string, deadline?: number): Promise<void> {
    const url = new URL(prebuiltMarkerPath, origin); url.searchParams.set('artifact', state.artifactSha256);
    const value = record(await request(signal => this.transport.buildInfo(url.href, signal), this.requestMs(deadline), this.signal));
    if (!matchesPrebuiltMarker(value, state)) throw new ReleaseError('ARTIFACT_CHANGED', { reason: 'REMOTE_MARKER' });
  }
  async ready(state: PrebuiltReleaseState): Promise<ReleaseDeployment> {
    const deadline = Date.now() + this.config.limits.deploymentMs;
    do {
      assertActive(this.signal); const result = await this.candidate(state, deadline);
      if (result.state === 'READY') { await this.marker(state, result.url, deadline); return result; }
      if (['ERROR', 'CANCELED', 'CANCELLED'].includes(result.state)) throw new ReleaseError('DEPLOYMENT_FAILED', { deploymentId: result.id, state: result.state });
      const remaining = deadline - Date.now(); if (remaining <= 0) break;
      await this.pause(remaining);
    } while (Date.now() < deadline);
    throw new ReleaseError('DEPLOYMENT_TIMEOUT');
  }
  async promotion(state: PrebuiltReleaseState, deadline?: number): Promise<'succeeded' | 'failed' | 'pending'> {
    const project = await this.project(deadline, true), job = record(project.lastAliasRequest);
    return job.toDeploymentId === state.deploymentId && job.type === 'promote' && ['succeeded', 'failed'].includes(String(job.jobStatus))
      ? job.jobStatus as 'succeeded' | 'failed' : 'pending';
  }
  async alias(state: PrebuiltReleaseState, deadline?: number): Promise<void> {
    const promotion = await this.promotion(state, deadline);
    if (promotion === 'failed') throw new ReleaseError('DEPLOYMENT_FAILED', { reason: 'PROMOTION_FAILED' });
    if (promotion !== 'succeeded') throw new ReleaseError('ALIAS_MISMATCH', { reason: 'PROMOTION_NOT_COMPLETE' });
    const host = new URL(this.config.vercel.productionUrl).hostname;
    const value = record(await this.api(`/v4/aliases/${encodeURIComponent(host)}`, deadline));
    if (value.alias !== host || value.projectId !== this.config.vercel.projectId || value.deploymentId !== state.deploymentId) throw new ReleaseError('ALIAS_MISMATCH');
    await this.marker(state, this.config.vercel.productionUrl, deadline);
    const url = new URL(this.config.buildInfo.path, this.config.vercel.productionUrl); url.searchParams.set('revision', state.sourceSha);
    const info = record(await request(signal => this.transport.buildInfo(url.href, signal), this.requestMs(deadline), this.signal));
    if (info[this.config.buildInfo.revisionField] !== state.sourceSha) throw new ReleaseError('BUILD_REVISION');
  }
  async waitAlias(state: PrebuiltReleaseState): Promise<void> {
    const deadline = Date.now() + this.config.limits.deploymentMs;
    do {
      try { await this.alias(state, deadline); return; } catch (error) {
        assertActive(this.signal);
        if (error instanceof ReleaseError && error.code === 'DEPLOYMENT_TIMEOUT') break;
        if (!(error instanceof ReleaseError) || error.code !== 'ALIAS_MISMATCH') throw error;
      }
      const remaining = deadline - Date.now(); if (remaining <= 0) break;
      await this.pause(remaining);
    } while (Date.now() < deadline);
    throw new ReleaseError('ALIAS_MISMATCH');
  }
}
