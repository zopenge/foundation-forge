import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ManagedSession } from './release-context.js';
import { createManagedExecution } from './managed-execution.js';
import { assertCandidate, assertRepository } from './git.js';
import { assertSourceFrozen, readCommittedConfig } from './source.js';
import { assertManagedPaths } from './managed-paths.js';
import { gitBlob } from './git-stream.js';
import { pathExists } from './managed-io.js';
import { record, ReleaseError } from './errors.js';

export async function assertCheckoutFrozen(session: ManagedSession): Promise<void> {
  const { slot, execution } = session;
  await assertManagedPaths(slot.paths); await slot.lock.assertOwned();
  await execution.observeCheckout(async () => {
    await assertRepository(execution, slot.source.config); await assertCandidate(execution, slot.source.config, slot.source.sha);
    const committed = await readCommittedConfig(execution, slot.source.sha, slot.source.configPath);
    if (committed.oid !== slot.source.configBlobOid || !(await readFile(resolve(slot.paths.checkoutRoot, slot.source.configPath))).equals(committed.bytes)) throw new ReleaseError('CANDIDATE_CHANGED', { reason: 'CHECKOUT_CONFIG' });
  });
}
export async function prepareCheckout(session: ManagedSession): Promise<void> {
  const { slot, execution } = session, { source, paths } = slot;
  const original = createManagedExecution(source.root, source.config, undefined, []);
  session.state.stage = 'checkout'; await session.persist();
  await assertSourceFrozen(source, original); await assertManagedPaths(paths);
  const exists = await pathExists(paths.checkoutRoot);
  if (!exists) {
    // 仅为本次 clone 和新建 checkout 启用长路径，不修改源仓库或宿主 Git 配置。
    await session.executionAt(paths.slotRoot).git(['-c', 'core.longpaths=true', 'clone', '--no-checkout', '--no-local', '--template=', '--config', 'core.autocrlf=false', '--config', 'core.eol=lf', '--config', 'core.longpaths=true', '--origin', source.config.git.remote, '--', source.fetchUrl, paths.checkoutRoot]);
  } else { await assertRepository(execution, source.config); await assertCandidate(execution, source.config); }
  await assertManagedPaths(paths); await assertSourceFrozen(source, original);
  await assertRepository(execution, source.config);
  await execution.git(['fetch', '--no-tags', '--no-recurse-submodules', '--', source.root, source.sha]);
  await assertSourceFrozen(source, original);
  if (!exists) {
    let branchExists = false;
    try { await execution.git(['show-ref', '--verify', '--quiet', `refs/heads/${source.config.git.developmentBranch}`]); branchExists = true; }
    catch (error) { if (!(error instanceof ReleaseError && error.code === 'GIT_FAILED' && error.details.exitCode === 1)) throw error; }
    if (branchExists) {
      // 新 clone 的默认分支可能已是开发分支；正常检出后仅允许快进，不重置已有引用。
      await execution.git(['switch', '--detach', source.sha]);
      await execution.git(['switch', source.config.git.developmentBranch]);
      await execution.git(['merge', '--ff-only', source.sha]);
    } else await execution.git(['switch', '--create', source.config.git.developmentBranch, source.sha]);
  }
  else if (await execution.git(['rev-parse', 'HEAD']) !== source.sha) {
    try { await execution.git(['merge-base', '--is-ancestor', 'HEAD', source.sha]); }
    catch (error) { if (error instanceof ReleaseError && error.details.exitCode === 1) throw new ReleaseError('SLOT_NOT_FAST_FORWARD'); throw error; }
    await execution.git(['merge', '--ff-only', source.sha]);
  }
  await assertCheckoutFrozen(session);
}
export async function prepareEnvironment(session: ManagedSession): Promise<void> {
  const { slot, execution } = session, { source } = slot;
  session.state.stage = 'install'; await session.persist();
  const manifestOid = await execution.git(['rev-parse', '--verify', `${source.sha}:package.json`]);
  const manifestBytes = await gitBlob(execution, manifestOid);
  let manifest: Record<string, unknown>;
  try { manifest = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)) as unknown); }
  catch { throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'PACKAGE_MANIFEST' }); }
  const match = typeof manifest.packageManager === 'string' ? /^pnpm@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+sha(?:224|256|384|512)\.[a-f0-9]+)?$/u.exec(manifest.packageManager) : null;
  if (!match) throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'EXACT_PNPM_REQUIRED' });
  await execution.git(['rev-parse', '--verify', `${source.sha}:pnpm-lock.yaml`]);
  const values = { COREPACK_ENABLE_PROJECT_SPEC: '0', npm_config_manage_package_manager_versions: 'false' };
  const version = await execution.run('package-manager-version', { command: 'pnpm', args: ['--version'] }, 'COMMAND_FAILED', values);
  if (version !== match[1]) throw new ReleaseError('SOURCE_UNSUPPORTED', { reason: 'PNPM_VERSION', expected: match[1], actual: version });
  await execution.run('install', { command: 'pnpm', args: ['install', '--frozen-lockfile'] }, 'COMMAND_FAILED', values);
  await assertCheckoutFrozen(session);
  if (source.config.source.mode !== 'managed-commit') throw new ReleaseError('SOURCE_UNSUPPORTED');
  session.state.stage = 'prepare'; await session.persist();
  for (const [index, check] of source.config.source.prepare.entries()) await execution.run(`prepare:${String(index)}`, check, 'COMMAND_FAILED');
  await assertCheckoutFrozen(session);
}
