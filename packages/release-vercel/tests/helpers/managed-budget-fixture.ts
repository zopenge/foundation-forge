import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ManagedSourceConfig } from '../../src/contracts.js';
import type { ManagedPaths } from '../../src/node/release-context.js';
import { atomicJson, fileIdentity } from '../../src/node/managed-io.js';
import { assertManagedPaths } from '../../src/node/managed-paths.js';
import { acquireLock } from '../../src/node/lock.js';
import { metadataReserveBytes } from '../../src/node/managed-metadata.js';

/** 预算组件保留真实文件身份、锁及原子写入；Git 准入由独立集成测试覆盖。 */
export async function managedBudgetFixture() {
  const base = resolve(import.meta.dirname, '../../../../.tmp/managed-budget-tests');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(resolve(base, 'r-'));
  const dispose = async () => {
    let target: string;
    try { target = await realpath(root); }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return; throw error; }
    const contained = relative(base, target);
    if (!contained || contained === '..' || contained.startsWith('..\\') || contained.startsWith('../') || isAbsolute(contained)) throw new Error('fixture cleanup escaped its owned base');
    await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  };
  try {
    const sourceRoot = resolve(root, 'source 空间 with spaces'), slotRoot = resolve(sourceRoot, '.tmp/release-slot');
    const anchorPath = resolve(sourceRoot, '.tmp/forge-vercel-release/managed.json');
    await mkdir(slotRoot, { recursive: true }); await mkdir(resolve(anchorPath, '..'), { recursive: true });
    const paths: ManagedPaths = { sourceRoot, slotRoot, anchorPath, checkoutRoot: resolve(slotRoot, 'checkout'),
      ownershipPath: resolve(slotRoot, 'ownership.json'), statePath: resolve(slotRoot, 'state.json'),
      lockPath: resolve(slotRoot, 'run.lock'), recoveryLockPath: resolve(slotRoot, 'recover.lock'),
      sourceIdentity: await fileIdentity(sourceRoot), slotIdentity: await fileIdentity(slotRoot) };
    const limits: ManagedSourceConfig = { mode: 'managed-commit', slotPath: '.tmp/release-slot', maxBytes: 2 ** 31,
      minFreeBytes: 5 * 2 ** 30, sampleIntervalMs: 250, install: { packageManager: 'pnpm' }, prepare: [] };
    const lock = await acquireLock(paths.lockPath), slotId = randomUUID();
    const guard = async () => { await assertManagedPaths(paths); await lock.assertOwned(); };
    const writeAnchor = () => atomicJson(anchorPath, { schemaVersion: 2, slotId, slotPath: slotRoot,
      sourceRoot, configPath: 'release.config.json' }, 65_536, paths, guard,
    limits.maxBytes - metadataReserveBytes, limits.minFreeBytes + metadataReserveBytes);
    return { root, paths, limits, lock, writeAnchor, dispose };
  } catch (error) { await dispose(); throw error; }
}
