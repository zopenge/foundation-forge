import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReleaseConfig } from '../contracts.js';
import { redact, ReleaseError } from './errors.js';
import type { Execution } from './execution.js';
import { gitRecords } from './git-stream.js';

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
  const urls = await execution.git(['config', '--get-regexp', `^remote\\.${remote}\\.(url|pushurl)$`]).catch((error: unknown) => {
    if (error instanceof ReleaseError && error.code === 'GIT_FAILED' && error.details.exitCode === 1
      && error.details.termination === 'exit') throw new ReleaseError('GIT_REPOSITORY', { reason: 'REMOTE_MISSING' });
    throw error;
  });
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
  // 同一次受管 status 读取分支、HEAD 与工作树，减少重复授权/持久化，不跨检查缓存。
  let branch: string | undefined, head: string | undefined, dirty = '';
  const invalid = () => new ReleaseError('GIT_FAILED', { reason: 'STATUS_PROTOCOL' });
  try {
    // 元数据增量解析沿用有界 NUL 协议，不能占用应用输出捕获预算而误拒绝长分支。
    await gitRecords(execution, ['status', '--porcelain=v2', '--branch', '--no-ahead-behind', '-z', '--untracked-files=all'], entry => {
      if (entry === '') throw invalid();
      // rename 的第二条 NUL 记录是路径，可能恰似 header；已知脏状态后不再解释路径为头部。
      if (dirty !== '') return;
      if (entry.startsWith('# branch.oid ')) {
        if (head !== undefined) throw invalid(); head = entry.slice('# branch.oid '.length);
      } else if (entry.startsWith('# branch.head ')) {
        if (branch !== undefined) throw invalid(); branch = entry.slice('# branch.head '.length);
      } else if (!entry.startsWith('# ')) {
        if (!/^(?:1 |2 |u |\? )/u.test(entry)) throw invalid(); dirty = entry;
      }
    });
  } catch (error) {
    if (error instanceof ReleaseError) {
      const reason = error.details.reason;
      if (error.code === 'SOURCE_UNSUPPORTED' && typeof reason === 'string'
        && ['TREE_LIMIT', 'TREE_RECORD_LIMIT', 'INCOMPLETE_GIT_RECORD', 'INVALID_UTF8'].includes(reason)) {
        throw new ReleaseError('GIT_FAILED', { reason: 'STATUS_PROTOCOL', protocolReason: reason });
      }
      if (error.code === 'GIT_FAILED' && error.details.termination === 'timeout') throw new ReleaseError('COMMAND_TIMEOUT', { step: 'git' });
    }
    throw error;
  }
  if (!branch || !head || !/^[a-f0-9]{40}$/u.test(head)) throw invalid();
  if (branch !== config.git.developmentBranch) throw new ReleaseError('GIT_BRANCH');
  if (sha !== undefined && (head !== sha || dirty !== '')) throw new ReleaseError('CANDIDATE_CHANGED', { reason: head !== sha ? 'HEAD_CHANGED' : 'WORKTREE_CHANGED', head, dirty: redact(dirty) });
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
