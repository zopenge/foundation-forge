import type { ReleaseConfig } from '../contracts.js';
import { record, ReleaseError } from './errors.js';
import { normalizeRepository } from './git.js';

export interface LinkedRepository { readonly type: string; readonly id: string; readonly host?: string; readonly workspaceId?: string }
function sourceError(reason: string): never { throw new ReleaseError('DEPLOYMENT_SOURCE', { reason }); }
function identifier(value: unknown): string {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).length === 0) sourceError('REPOSITORY_ID');
  return String(value);
}
function component(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.-]+$/u.test(value)) sourceError('REPOSITORY_NAME');
  return value;
}
function normalizeHost(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9.-]+(?::\d+)?$/u.test(value)) sourceError('GIT_HOST');
  try { return new URL(`https://${value}`).host.toLowerCase(); }
  catch { return sourceError('GIT_HOST'); }
}
export function linkedRepository(project: Record<string, unknown>, config: ReleaseConfig): LinkedRepository {
  const link = record(project.link);
  if (link.productionBranch !== config.git.releaseBranch) sourceError('PRODUCTION_BRANCH');
  let repository: string, id: string, workspaceId: string | undefined, host: string | undefined;
  const type = String(link.type);
  if (['github', 'github-limited', 'github-custom-host'].includes(type)) {
    const repositoryHost = type === 'github-custom-host' ? normalizeHost(link.host) : 'github.com';
    if (type === 'github-custom-host') host = repositoryHost;
    repository = `${repositoryHost}/${component(link.org)}/${component(link.repo)}`;
    id = identifier(link.repoId);
  } else if (type === 'gitlab') {
    if (typeof link.projectUrl !== 'string' || !/^https?:\/\//u.test(link.projectUrl)) sourceError('REPOSITORY_URL');
    repository = normalizeRepository(link.projectUrl, '.'); id = identifier(link.projectId);
  } else if (type === 'bitbucket') {
    repository = `bitbucket.org/${component(link.owner)}/${component(link.slug)}`;
    id = identifier(link.uuid); workspaceId = identifier(link.workspaceUuid);
  } else return sourceError('GIT_PROVIDER');
  if (normalizeRepository(repository, '.') !== normalizeRepository(config.git.repository, '.')) sourceError('PROJECT_REPOSITORY');
  return { type, id, ...(host === undefined ? {} : { host }), ...(workspaceId === undefined ? {} : { workspaceId }) };
}
export function assertGitSource(value: unknown, linked: LinkedRepository, config: ReleaseConfig, sha: string): void {
  const source = record(value);
  if (source.type !== linked.type || source.sha !== sha || source.ref !== config.git.releaseBranch) sourceError('GIT_SOURCE');
  if (linked.host !== undefined && normalizeHost(source.host) !== linked.host) sourceError('GIT_SOURCE_HOST');
  const id = linked.type === 'gitlab' ? source.projectId : linked.type === 'bitbucket' ? source.repoUuid : source.repoId;
  if (identifier(id) !== linked.id || (linked.workspaceId !== undefined && source.workspaceUuid !== linked.workspaceId)) sourceError('GIT_SOURCE_REPOSITORY');
}
