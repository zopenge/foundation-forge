import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { calculateBytesIntegrity } from '@openge/forge-artifact-integrity';
import type { ReleaseConfig } from '../contracts.js';
import type { Execution } from './execution.js';
import { ReleaseError } from './errors.js';
import type { FrozenSource } from './release-context.js';
import { assertRepository } from './git.js';
import { gitBlob, gitRecords } from './git-stream.js';
import { validateReleaseConfig } from './config.js';
import { assertNoGitContext } from './git-context.js';

export const configDigest = async (config: ReleaseConfig): Promise<string> =>
  (await calculateBytesIntegrity(new TextEncoder().encode(JSON.stringify(config)))).sha256;
export function relativeConfigPath(root: string, path: string): string {
  const value = relative(root, resolve(root, path)).replaceAll('\\', '/');
  if (!value || isAbsolute(value) || value.split('/').some(part => ['..', '.git'].includes(part.toLowerCase())) || /[\0\r\n]/u.test(value)) {
    throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'CONFIG_PATH' });
  }
  return value;
}
export async function readCommittedConfig(execution: Execution, sha: string, path: string): Promise<{ config: ReleaseConfig; oid: string; bytes: Buffer }> {
  const oid = await execution.git(['rev-parse', '--verify', '--quiet', `${sha}:${path}`]).catch((error: unknown) => {
    // quiet 存在性检查仅在正常退出 1 时证明配置路径缺失，不能吞掉启动或观察失败。
    if (error instanceof ReleaseError && error.code === 'GIT_FAILED' && error.details.exitCode === 1
      && error.details.termination === 'exit') throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'CONFIG_NOT_COMMITTED' });
    throw error;
  });
  const bytes = await gitBlob(execution, oid);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new ReleaseError('CONFIG_READ', { reason: 'COMMITTED_JSON' }); }
  return { config: validateReleaseConfig(value), oid, bytes };
}
async function assertTrackedClean(execution: Execution): Promise<void> {
  for (const args of [['diff', '--quiet', '--'], ['diff', '--cached', '--quiet', '--']]) {
    try { await execution.git(args); }
    catch (error) {
      if (error instanceof ReleaseError && error.code === 'GIT_FAILED' && error.details.exitCode === 1
        && error.details.termination === 'exit') throw new ReleaseError('GIT_DIRTY');
      throw error;
    }
  }
}
export async function freezeManagedSource(cwd: string, configPath: string, execution: Execution): Promise<FrozenSource> {
  assertNoGitContext();
  const root = await realpath(cwd), path = relativeConfigPath(root, configPath), absolute = resolve(root, path);
  if (!(await lstat(absolute)).isFile() || await realpath(absolute) !== absolute) throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'CONFIG_LINK' });
  const sha = await execution.git(['rev-parse', '--verify', 'HEAD']);
  if (!/^[a-f0-9]{40}$/u.test(sha)) throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'OBJECT_FORMAT' });
  const committed = await readCommittedConfig(execution, sha, path);
  if (committed.config.source.mode !== 'managed-commit') throw new ReleaseError('SOURCE_UNSUPPORTED');
  if (!(await readFile(absolute)).equals(committed.bytes)) throw new ReleaseError('GIT_DIRTY', { reason: 'CONFIG_CHANGED' });
  await assertRepository(execution, committed.config);
  if (await execution.git(['branch', '--show-current']) !== committed.config.git.developmentBranch) throw new ReleaseError('GIT_BRANCH');
  await assertTrackedClean(execution);
  const source: FrozenSource = { root, sha, configPath: path, config: committed.config, configBlobOid: committed.oid,
    configSha256: await configDigest(committed.config), fetchUrl: await execution.git(['config', '--get', `remote.${committed.config.git.remote}.url`]) };
  await assertSourceFrozen(source, execution);
  return source;
}
export async function assertSourceFrozen(source: FrozenSource, execution: Execution): Promise<void> {
  try {
    assertNoGitContext();
    await assertRepository(execution, source.config);
    if (await realpath(execution.cwd) !== source.root || await execution.git(['rev-parse', 'HEAD']) !== source.sha
      || await execution.git(['branch', '--show-current']) !== source.config.git.developmentBranch
      || await execution.git(['config', '--get', `remote.${source.config.git.remote}.url`]) !== source.fetchUrl) throw new ReleaseError('SOURCE_CHANGED');
    await assertTrackedClean(execution);
    if (await realpath(resolve(source.root, source.configPath)) !== resolve(source.root, source.configPath)
      || !(await readFile(resolve(source.root, source.configPath))).equals(await gitBlob(execution, source.configBlobOid))) throw new ReleaseError('SOURCE_CHANGED');
  } catch (error) {
    // 观察失败不证明源码发生变化；保留命令层已经分类的首错。
    if (error instanceof ReleaseError && ['CANCELLED', 'GIT_FAILED', 'COMMAND_TIMEOUT', 'PROCESS_STATE_UNKNOWN'].includes(error.code)) throw error;
    throw new ReleaseError('SOURCE_CHANGED');
  }
}
export async function inspectCommitTree(source: FrozenSource, execution: Execution): Promise<void> {
  await gitRecords(execution, ['ls-tree', '-rz', '--full-tree', source.sha], entry => {
    const match = /^(100644|100755) blob [a-f0-9]{40}\t([\s\S]+)$/u.exec(entry), path = match?.[2];
    if (!path || path.split('/').some(part => ['.', '..', '.git'].includes(part.toLowerCase()))
      || (process.platform === 'win32' && (/[<>:"\\|?*]/u.test(path) || [...path].some(character => character.charCodeAt(0) < 32)
        || path.split('/').some(part => /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))))) throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'TREE_ENTRY' });
  });
  let lfs = false;
  await execution.streamGit(['grep', '-a', '-l', '-z', '--no-textconv', '-e', '^version https://git-lfs.github.com/spec/v1$', source.sha, '--'], () => { lfs = true; }, [0, 1]);
  if (lfs) throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'LFS_POINTER' });
}
