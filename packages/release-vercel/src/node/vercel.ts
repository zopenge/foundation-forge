import { setTimeout as delay } from 'node:timers/promises';
import type { ReleaseConfig, ReleaseDeployment, ReleaseTransport } from '../contracts.js';
import { assertActive, record, ReleaseError } from './errors.js';
import { Execution, vercelInvocation } from './execution.js';
import { assertGitSource, linkedRepository, type LinkedRepository } from './git-source.js';

export function createTransport(execution: Execution): ReleaseTransport {
  return {
    api: async (path, signal) => {
      const invocation = vercelInvocation(['api', path, '--method', 'GET', '--raw', '--non-interactive']);
      const stdout = await execution.run('vercel-api', { ...invocation, timeoutMs: execution.config.limits.requestMs },
        'VERCEL_API', undefined, signal, false);
      try { return JSON.parse(stdout) as unknown; } catch { throw new ReleaseError('VERCEL_API', { reason: 'INVALID_JSON' }); }
    },
    buildInfo: async (url, signal) => {
      const response = await fetch(url, { method: 'GET', signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
        headers: { 'cache-control': 'no-cache', accept: 'application/json' } });
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new ReleaseError('BUILD_INFO', { status: response.status }); }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let length = 0;
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > execution.config.limits.maxOutputBytes) throw new ReleaseError('BUILD_INFO', { reason: 'OUTPUT_LIMIT' });
          chunks.push(chunk.value);
        }
      } finally { await reader.cancel(); reader.releaseLock(); }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
      catch { throw new ReleaseError('BUILD_INFO', { reason: 'INVALID_JSON' }); }
    },
  };
}
export async function request<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, signal: AbortSignal | undefined): Promise<T> {
  assertActive(signal);
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new ReleaseError(signal?.aborted ? 'CANCELLED' : 'VERCEL_API', { reason: 'REQUEST_TIMEOUT' }));
    combined.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([operation(combined), aborted]); }
  catch (error) { assertActive(signal); throw error; }
  finally { if (onAbort) combined.removeEventListener('abort', onAbort); }
}
function commitSha(value: Record<string, unknown>): unknown {
  const source = record(value.gitSource), meta = record(value.meta);
  return source.sha ?? meta.githubCommitSha ?? meta.gitlabCommitSha ?? meta.bitbucketCommitSha;
}
function deployment(value: unknown, config: ReleaseConfig, sha: string, linked: LinkedRepository): ReleaseDeployment {
  const entry = record(value);
  const projectId = entry.projectId ?? record(entry.project).id;
  const id = entry.id ?? entry.uid;
  assertGitSource(entry.gitSource, linked, config, sha);
  if (projectId !== config.vercel.projectId
    || entry.target !== 'production'
    || typeof id !== 'string' || typeof entry.url !== 'string') throw new ReleaseError('DEPLOYMENT_SOURCE');
  return { id, sha, projectId: config.vercel.projectId, state: String(entry.readyState ?? entry.state), url: entry.url };
}
export class VercelVerification {
  private linked: LinkedRepository | undefined;
  constructor(readonly config: ReleaseConfig, readonly transport: ReleaseTransport, readonly signal: AbortSignal | undefined) {}
  api(path: string): Promise<unknown> {
    const separator = path.includes('?') ? '&' : '?';
    return request(signal => this.transport.api(`${path}${separator}teamId=${encodeURIComponent(this.config.vercel.teamId)}`, signal), this.config.limits.requestMs, this.signal);
  }
  async project(): Promise<void> {
    const response = record(await this.api(`/v9/projects/${encodeURIComponent(this.config.vercel.projectId)}`));
    if (response.id !== this.config.vercel.projectId || response.accountId !== this.config.vercel.teamId) {
      throw new ReleaseError('DEPLOYMENT_SOURCE', { reason: 'PROJECT_MISMATCH' });
    }
    this.linked = linkedRepository(response, this.config);
  }
  async find(sha: string): Promise<ReleaseDeployment | undefined> {
    await this.project();
    const query = new URLSearchParams({ projectId: this.config.vercel.projectId, target: 'production', sha, limit: '100' });
    const response = record(await this.api(`/v6/deployments?${query.toString()}`));
    if (!Array.isArray(response.deployments)) throw new ReleaseError('VERCEL_API', { reason: 'INVALID_DEPLOYMENTS' });
    const match = response.deployments.map(record).find(entry => commitSha(entry) === sha || record(entry.meta).githubCommitSha === sha
      || record(entry.meta).gitlabCommitSha === sha || record(entry.meta).bitbucketCommitSha === sha);
    if (!match) return undefined;
    const id = match.uid ?? match.id;
    if (typeof id !== 'string') throw new ReleaseError('DEPLOYMENT_SOURCE');
    const details = await this.api(`/v13/deployments/${encodeURIComponent(id)}?withGitRepoInfo=true`);
    if (!this.linked) throw new ReleaseError('DEPLOYMENT_SOURCE');
    return deployment(details, this.config, sha, this.linked);
  }
  async wait(sha: string): Promise<ReleaseDeployment> {
    const deadline = Date.now() + this.config.limits.deploymentMs;
    do {
      assertActive(this.signal);
      const result = await this.find(sha);
      if (result?.state === 'READY') return result;
      if (result && ['ERROR', 'CANCELED', 'CANCELLED'].includes(result.state)) throw new ReleaseError('DEPLOYMENT_FAILED', { deploymentId: result.id, state: result.state });
      const remaining = deadline - Date.now(); if (remaining <= 0) break;
      try { await delay(Math.min(this.config.limits.pollMs, remaining), undefined, this.signal === undefined ? {} : { signal: this.signal }); }
      catch { assertActive(this.signal); throw new ReleaseError('DEPLOYMENT_TIMEOUT'); }
    } while (Date.now() < deadline);
    throw new ReleaseError('DEPLOYMENT_TIMEOUT');
  }
  async verify(result: ReleaseDeployment): Promise<void> {
    if (result.state !== 'READY') throw new ReleaseError('DEPLOYMENT_FAILED', { state: result.state });
    const host = new URL(this.config.vercel.productionUrl).hostname;
    const alias = record(await this.api(`/v4/aliases/${encodeURIComponent(host)}`));
    if (alias.projectId !== this.config.vercel.projectId || alias.deploymentId !== result.id || alias.alias !== host) {
      throw new ReleaseError('ALIAS_MISMATCH');
    }
    const url = new URL(this.config.buildInfo.path, this.config.vercel.productionUrl);
    url.searchParams.set('revision', result.sha);
    let info: unknown;
    try { info = await request(signal => this.transport.buildInfo(url.href, signal), this.config.limits.requestMs, this.signal); }
    catch (error) { if (error instanceof ReleaseError) throw error; throw new ReleaseError('BUILD_INFO'); }
    if (record(info)[this.config.buildInfo.revisionField] !== result.sha) throw new ReleaseError('BUILD_REVISION');
  }
}
