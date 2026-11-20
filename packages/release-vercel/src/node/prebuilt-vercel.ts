import { setTimeout as delay } from 'node:timers/promises';
import type { NodeHttpTransportOptions } from '@openge/forge-http-transport';
import type { PrebuiltMarkerCandidate, PrebuiltReleaseState, ReleaseConfig, ReleaseDeployment, ReleaseTransport, VersionAliasAssignment, VersionAliasBinding, VersionAliasTransport } from '../contracts.js';
import type { CandidateMarkerHeaders } from './candidate-marker-auth.js';
import { assertActive, record, ReleaseError } from './errors.js';
import type { Execution } from './execution.js';
import { matchesPrebuiltMarker, prebuiltMarkerPath } from './prebuilt-artifact.js';
import { request } from './vercel.js';
import { prebuiltApiOnce } from './prebuilt-http.js';
import { readBuildInfo } from './build-info-http.js';
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
export async function promotePrebuiltOnce(config: ReleaseConfig, deploymentId: string, signal: AbortSignal, apiHttp?: NodeHttpTransportOptions): Promise<void> {
  const path = `/v10/projects/${encodeURIComponent(config.vercel.projectId)}/promote/${candidateId(deploymentId)}?teamId=${encodeURIComponent(config.vercel.teamId)}`;
  await prebuiltApiOnce(config, path, 'POST', '{}', signal, { acceptStatuses: [201, 202], http: apiHttp });
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
async function readApiOnce(config: ReleaseConfig, path: string, signal: AbortSignal, allowMissing: boolean, timeoutMs: number, apiHttp?: NodeHttpTransportOptions) {
  try { return await prebuiltApiOnce(config, path, 'GET', '', signal, { acceptStatuses: allowMissing ? [200, 404] : [200], timeoutMs, http: apiHttp }); }
  catch (error) {
    if (error instanceof ReleaseError) throw error;
    throw new ReleaseError('VERCEL_API', { reason: 'REQUEST_UNCONFIRMED' });
  }
}
export async function readPrebuiltVersionAlias(config: ReleaseConfig, hostname: string, signal: AbortSignal, timeoutMs = config.limits.requestMs,
  apiHttp?: NodeHttpTransportOptions): Promise<VersionAliasBinding | undefined> {
  const path = `/v4/aliases/${aliasHostname(config, hostname)}?teamId=${encodeURIComponent(config.vercel.teamId)}`;
  const response = await readApiOnce(config, path, signal, true, timeoutMs, apiHttp);
  if (response.status === 404) return;
  const value = jsonBody(response.body);
  if (value.alias !== hostname || typeof value.projectId !== 'string' || typeof value.deploymentId !== 'string'
    || value.redirect != null || value.microfrontends != null || value.deletedAt != null)
    throw new ReleaseError('VERSION_ALIAS_CONFLICT', { reason: 'DIRECT_BINDING_UNCONFIRMED' });
  return { alias: hostname, projectId: value.projectId, deploymentId: value.deploymentId, routing: 'direct' };
}
export async function assignPrebuiltVersionAliasOnce(config: ReleaseConfig, deploymentId: string, hostname: string,
  signal: AbortSignal, apiHttp?: NodeHttpTransportOptions): Promise<VersionAliasAssignment> {
  aliasHostname(config, hostname);
  const path = `/v2/deployments/${candidateId(deploymentId)}/aliases?teamId=${encodeURIComponent(config.vercel.teamId)}`;
  const response = await prebuiltApiOnce(config, path, 'POST', JSON.stringify({ alias: hostname }), signal, { http: apiHttp });
  const value = jsonBody(response.body);
  if (value.alias !== hostname || typeof value.uid !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(value.uid)
    || (value.oldDeploymentId !== undefined && typeof value.oldDeploymentId !== 'string'))
    throw new ReleaseError('VERCEL_API', { reason: 'VERSION_ALIAS_RESPONSE' });
  return { alias: hostname, uid: value.uid, ...(typeof value.oldDeploymentId === 'string' ? { oldDeploymentId: value.oldDeploymentId } : {}) };
}
export interface PrebuiltAccess {
  readonly transport: ReleaseTransport;
  readonly candidateMarker?: (url: string, candidate: PrebuiltMarkerCandidate, signal: AbortSignal) => Promise<unknown>;
  apiRead(path: string, signal: AbortSignal | undefined, deadline?: number): Promise<unknown>;
  aliasRead(adapter: VersionAliasTransport, hostname: string, signal: AbortSignal | undefined, deadline?: number): Promise<VersionAliasBinding | undefined>;
}
function requestLimit(config: ReleaseConfig, deadline?: number): number {
  const remaining = deadline === undefined ? config.limits.requestMs : deadline - Date.now();
  if (remaining <= 0) throw new ReleaseError('DEPLOYMENT_TIMEOUT');
  return Math.min(config.limits.requestMs, remaining);
}
async function nativeRead<T>(execution: Execution, config: ReleaseConfig, operation: (signal: AbortSignal, timeoutMs: number) => Promise<T>,
  signal?: AbortSignal, deadline?: number): Promise<T> {
  const value = await execution.observeRequest(combined => operation(combined, requestLimit(config, deadline)), signal);
  assertActive(signal);
  if (deadline !== undefined && deadline <= Date.now()) throw new ReleaseError('DEPLOYMENT_TIMEOUT');
  return value;
}
async function nativeApiRead(execution: Execution, config: ReleaseConfig, path: string, signal?: AbortSignal, deadline?: number,
  apiHttp?: NodeHttpTransportOptions): Promise<unknown> {
  return nativeRead(execution, config, async (combined, timeoutMs) => jsonBody((await readApiOnce(config, path, combined, false, timeoutMs, apiHttp)).body), signal, deadline);
}
async function nativeAliasRead(execution: Execution, config: ReleaseConfig, hostname: string, signal?: AbortSignal, deadline?: number, apiHttp?: NodeHttpTransportOptions) {
  try { return await nativeRead(execution, config, (combined, timeoutMs) => readPrebuiltVersionAlias(config, hostname, combined, timeoutMs, apiHttp), signal, deadline); }
  catch (error) {
    if (error instanceof ReleaseError && error.code === 'DEPLOYMENT_TIMEOUT') throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'VERSION_ALIAS_UNCONFIRMED' });
    throw error;
  }
}
/** 默认和 custom 在装配时显式选择；默认请求不会回退到 CLI 或 custom 路径。 */
export function createPrebuiltTransport(execution: Execution, config: ReleaseConfig, writing: boolean, http?: NodeHttpTransportOptions,
  supplied?: ReleaseTransport, candidateMarkerHeaders?: CandidateMarkerHeaders, apiHttp?: NodeHttpTransportOptions): PrebuiltAccess {
  if (supplied) return { transport: supplied,
    apiRead: (path, signal, deadline) => request(combined => supplied.api(path, combined), requestLimit(config, deadline), signal),
    aliasRead: (adapter, hostname, signal, deadline) => request(combined => adapter.read(hostname, combined), requestLimit(config, deadline), signal) };
  if (!process.env.VERCEL_TOKEN) throw new ReleaseError('AUTH_REQUIRED', { reason: 'PREBUILT_TOKEN_REQUIRED' });
  let versionAlias: VersionAliasTransport | undefined;
  if (config.delivery?.versionAlias) versionAlias = { read: (hostname, signal) => nativeAliasRead(execution, config, hostname, signal, undefined, apiHttp),
    ...(writing ? { assign: (id: string, hostname: string, signal: AbortSignal) => assignPrebuiltVersionAliasOnce(config, id, hostname, signal, apiHttp) } : {}) };
  const transport: ReleaseTransport = {
    api: (path, signal) => nativeApiRead(execution, config, path, signal, undefined, apiHttp),
    buildInfo: (url, signal) => readBuildInfo(url, signal, config.limits.maxOutputBytes, http),
    promote: (id, signal) => promotePrebuiltOnce(config, id, signal, apiHttp), ...(versionAlias ? { versionAlias } : {}) };
  return { transport, apiRead: (path, signal, deadline) => nativeApiRead(execution, config, path, signal, deadline, apiHttp),
    ...(candidateMarkerHeaders ? { candidateMarker: async (url, candidate, signal) => {
      const headers = await candidateMarkerHeaders(candidate, signal);
      assertActive(signal);
      return readBuildInfo(url, signal, config.limits.maxOutputBytes, http, headers);
    } } : {}),
    aliasRead: (_adapter, hostname, signal, deadline) => nativeAliasRead(execution, config, hostname, signal, deadline, apiHttp) };
}
const failedDeploymentStates = ['ERROR', 'CANCELED', 'CANCELLED'];

/** 保留已核对候选的当次失败观察，供只读 status 返回原收据和新诊断。 */
export class PrebuiltStatusFailure extends ReleaseError {
  constructor(readonly deployment: ReleaseDeployment, blockCode: unknown) {
    super('DEPLOYMENT_FAILED', { deploymentId: deployment.id, state: deployment.state, observedAt: new Date().toISOString(),
      ...(blockCode === 'TEAM_ACCESS_REQUIRED' || blockCode === 'COMMIT_AUTHOR_REQUIRED' ? { providerBlockCode: blockCode } : {}) });
  }
}

export class PrebuiltVerification {
  constructor(readonly config: ReleaseConfig, private readonly access: PrebuiltAccess, readonly signal?: AbortSignal) {}
  get transport(): ReleaseTransport { return this.access.transport; }
  private requestMs(deadline?: number): number {
    return requestLimit(this.config, deadline);
  }
  private async pause(remaining: number): Promise<void> {
    try { await delay(Math.min(this.config.limits.pollMs, remaining), undefined, this.signal ? { signal: this.signal } : {}); }
    catch (error) { assertActive(this.signal); throw error; }
  }
  api(path: string, deadline?: number): Promise<unknown> {
    return this.access.apiRead(`${path}${path.includes('?') ? '&' : '?'}teamId=${encodeURIComponent(this.config.vercel.teamId)}`, this.signal, deadline);
  }
  readVersionAlias(adapter: VersionAliasTransport, hostname: string, deadline?: number): Promise<VersionAliasBinding | undefined> {
    return this.access.aliasRead(adapter, hostname, this.signal, deadline);
  }
  async project(deadline?: number, allowPending = false): Promise<Record<string, unknown>> {
    // Vercel 只在显式请求 rollbackInfo 时返回实际的推广或回滚任务状态。
    const project = record(await this.api(`/v9/projects/${encodeURIComponent(this.config.vercel.projectId)}?rollbackInfo=true`, deadline));
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
  async candidate(state: PrebuiltReleaseState, deadline?: number, purpose?: 'status'): Promise<ReleaseDeployment> {
    const id = candidateId(state.deploymentId), value = record(await this.api(`/v13/deployments/${id}`, deadline));
    if (value.id !== id || value.projectId !== this.config.vercel.projectId || value.ownerId !== this.config.vercel.teamId
      || value.target !== 'production' || value.source !== 'cli') throw new ReleaseError('DEPLOYMENT_SOURCE', { reason: 'PREBUILT_CANDIDATE' });
    const origin = candidateOrigin(value.url);
    if (state.deploymentUrl && origin !== state.deploymentUrl) throw new ReleaseError('DEPLOYMENT_SOURCE', { reason: 'CANDIDATE_URL_CHANGED' });
    const readyState = value.readyState;
    const deployment = { id, sha: state.sourceSha, projectId: this.config.vercel.projectId, state: String(readyState), url: origin };
    if (purpose === 'status' && typeof readyState === 'string' && (readyState === 'BLOCKED' || failedDeploymentStates.includes(readyState))) {
      throw new PrebuiltStatusFailure(deployment, readyState === 'BLOCKED' ? record(value.seatBlock).blockCode : undefined);
    }
    return deployment;
  }
  async marker(state: PrebuiltReleaseState, origin: string, deadline?: number): Promise<void> {
    await this.assertMarker(state, origin, (url, signal) => this.transport.buildInfo(url, signal), deadline);
  }
  private async assertMarker(state: PrebuiltReleaseState, origin: string, read: ReleaseTransport['buildInfo'], deadline?: number): Promise<void> {
    const url = new URL(prebuiltMarkerPath, origin); url.searchParams.set('artifact', state.artifactSha256);
    const value = record(await request(signal => read(url.href, signal), this.requestMs(deadline), this.signal));
    if (!matchesPrebuiltMarker(value, state)) throw new ReleaseError('ARTIFACT_CHANGED', { reason: 'REMOTE_MARKER' });
  }
  private async readyMarker(state: PrebuiltReleaseState, deployment: ReleaseDeployment, deadline: number): Promise<void> {
    const read = this.access.candidateMarker, origin = deployment.url;
    if (!read) return this.marker(state, origin, deadline);
    if (origin !== state.deploymentUrl || origin === new URL(this.config.vercel.productionUrl).origin
      || origin === versionAliasOrigin(this.config, state.sourceSha)) throw new ReleaseError('AUTH_REQUIRED', { reason: 'CANDIDATE_MARKER_ORIGIN' });
    const candidate = { deploymentId: deployment.id, origin, projectId: this.config.vercel.projectId, teamId: this.config.vercel.teamId };
    await this.assertMarker(state, origin, (url, signal) => read(url, candidate, signal), deadline);
  }
  async ready(state: PrebuiltReleaseState, purpose?: 'status'): Promise<ReleaseDeployment> {
    const deadline = Date.now() + this.config.limits.deploymentMs;
    do {
      assertActive(this.signal); const result = await this.candidate(state, deadline, purpose);
      if (result.state === 'READY') { await this.readyMarker(state, result, deadline); return result; }
      if (failedDeploymentStates.includes(result.state)) throw new ReleaseError('DEPLOYMENT_FAILED', { deploymentId: result.id, state: result.state });
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
