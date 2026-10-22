import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReleaseConfig } from '../contracts.js';
import { ReleaseError } from './errors.js';
import type { Execution } from './execution.js';

export function normalizeRepository(value: string, cwd: string): string {
  const input = value.trim().replaceAll('\\', '/').replace(/\/$/u, '');
  if (isAbsolute(input) || input.startsWith('./') || input.startsWith('../')) return resolve(cwd, input).replaceAll('\\', '/');
  if (input.startsWith('file://')) return resolve(fileURLToPath(input)).replaceAll('\\', '/');
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/u.exec(input);
  if (!input.includes('://') && scp && !/^[^/:]+:\d+\//u.test(input)) return `${scp[1]?.toLowerCase()}/${scp[2]?.replace(/\.git$/iu, '')}`;
  if (input.includes('://')) {
    const url = new URL(input);
    if (url.password || (['http:', 'https:'].includes(url.protocol) && url.username) || url.search || url.hash) throw new ReleaseError('GIT_REPOSITORY');
    return `${url.host.toLowerCase()}${url.pathname}`.replace(/\.git$/iu, '');
  }
  return input.replace(/\.git$/iu, '');
}
export async function assertRepository(execution: Execution, config: ReleaseConfig): Promise<void> {
  const root = await execution.git(['rev-parse', '--show-toplevel']);
  if (resolve(root) !== resolve(execution.cwd)) throw new ReleaseError('GIT_REPOSITORY', { reason: 'ROOT_MISMATCH' });
  const remote = config.git.remote.replaceAll('.', '\\.');
  const urls = await execution.git(['config', '--get-regexp', `^remote\\.${remote}\\.(url|pushurl)$`]);
  const entries = urls.split(/\r?\n/u).map(line => /^(\S+)\s+(.+)$/u.exec(line));
  const fetch = entries.filter(entry => entry?.[1]?.endsWith('.url')).map(entry => entry?.[2] ?? '');
  const explicitPush = entries.filter(entry => entry?.[1]?.endsWith('.pushurl')).map(entry => entry?.[2] ?? '');
  const push = explicitPush.length === 0 ? fetch : explicitPush;
  const expected = normalizeRepository(config.git.repository, execution.cwd);
  if ([fetch, push].some(values => values.length !== 1 || normalizeRepository(values[0] ?? '', execution.cwd) !== expected)) {
    throw new ReleaseError('GIT_REPOSITORY', { reason: 'REMOTE_MISMATCH' });
  }
}
export async function assertCandidate(execution: Execution, config: ReleaseConfig, sha?: string): Promise<string> {
  if (await execution.git(['branch', '--show-current']) !== config.git.developmentBranch) throw new ReleaseError('GIT_BRANCH');
  const head = await execution.git(['rev-parse', 'HEAD']);
  const dirty = await execution.git(['status', '--porcelain=v1', '--untracked-files=all']);
  if (sha !== undefined && (head !== sha || dirty !== '')) throw new ReleaseError('CANDIDATE_CHANGED', { reason: head !== sha ? 'HEAD_CHANGED' : 'WORKTREE_CHANGED', head, dirty });
  if (dirty !== '') throw new ReleaseError('GIT_DIRTY');
  return head;
}
export async function remoteRefs(execution: Execution, config: ReleaseConfig): Promise<Record<string, string>> {
  const branches = [config.git.developmentBranch, config.git.releaseBranch];
  const output = await execution.git(['ls-remote', '--refs', config.git.remote, ...branches.map(branch => `refs/heads/${branch}`)]);
  const result: Record<string, string> = {};
  for (const line of output.split(/\r?\n/u)) {
    const [sha, ref] = line.split(/\s+/u);
    if (sha && /^[a-f0-9]{40}$/u.test(sha) && ref) result[ref.replace('refs/heads/', '')] = sha;
  }
  if (branches.some(branch => !result[branch])) throw new ReleaseError('GIT_DIVERGED', { reason: 'REMOTE_BRANCH_MISSING' });
  return result;
}
export async function fetchAndAssertFastForward(execution: Execution, config: ReleaseConfig, sha: string): Promise<Record<string, string>> {
  await assertRepository(execution, config);
  await execution.git(['fetch', '--no-tags', config.git.remote, `refs/heads/${config.git.developmentBranch}`, `refs/heads/${config.git.releaseBranch}`]);
  const refs = await remoteRefs(execution, config);
  for (const branch of [config.git.developmentBranch, config.git.releaseBranch]) {
    try { await execution.git(['merge-base', '--is-ancestor', refs[branch] ?? '', sha]); }
    catch (error) {
      if (error instanceof ReleaseError && error.code === 'GIT_FAILED' && error.details.exitCode === 1) throw new ReleaseError('GIT_DIVERGED', { branch });
      throw error;
    }
  }
  return refs;
}
