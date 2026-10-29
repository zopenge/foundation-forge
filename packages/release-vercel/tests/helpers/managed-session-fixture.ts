import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateReleaseConfig } from '../../src/node/config.js';
import { acquireLock } from '../../src/node/lock.js';
import { assertManagedPaths } from '../../src/node/managed-paths.js';
import { createManagedStateStore } from '../../src/node/managed-state.js';
import { currentCoordinator } from '../../src/node/process-identities.js';
import type { FrozenSource, ManagedSlot } from '../../src/node/release-context.js';
import { managedBudgetFixture } from './managed-budget-fixture.js';

/** 协议组件使用真实目录、锁、身份及状态存储；Git来源准入由专门集成用例验证。 */
export async function managedSessionFixture({ sampleIntervalMs = 250 } = {}) {
  const base = await managedBudgetFixture();
  try {
    const config = validateReleaseConfig({ schemaVersion: 2, source: { ...base.limits, sampleIntervalMs },
      git: { remote: 'origin', repository: 'github.com/fixture/repository', developmentBranch: 'dev', releaseBranch: 'main' },
      vercel: { teamId: 'team_fixture', projectId: 'prj_fixture', productionUrl: 'https://fixture.example.invalid' },
      checks: [{ command: 'node', args: ['-e', 'process.exit(0)'] }], acceptance: [{ command: 'node', args: ['-e', 'process.exit(0)'] }],
      buildInfo: { path: '/build-info.json', revisionField: 'revision' },
      limits: { commandMs: 15_000, deploymentMs: 1000, pollMs: 20, requestMs: 1000, maxOutputBytes: 4096 } });
    const bytes = Buffer.from(JSON.stringify(config)), runId = randomUUID(), slotId = randomUUID();
    // SHA是自包含的组件输入，不声称来自真实提交；配置blob按真实Git对象格式计算。
    const sha = createHash('sha1').update(runId).digest('hex');
    const source: FrozenSource = { root: base.paths.sourceRoot, sha, configPath: 'release.config.json', config,
      configSha256: createHash('sha256').update(bytes).digest('hex'),
      configBlobOid: createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex'),
      fetchUrl: 'https://github.com/fixture/repository.git' };
    await writeFile(resolve(source.root, source.configPath), bytes);
    await base.lock.release();
    const coordinator = await currentCoordinator(), lock = await acquireLock(base.paths.lockPath, { runId, identity: coordinator });
    const guard = async () => { await assertManagedPaths(base.paths); await lock.assertOwned(); };
    const store = createManagedStateStore(base.paths, source, slotId, guard);
    const slot: ManagedSlot = { paths: base.paths, source, slotId, runId, coordinator, lock, store,
      assertMetadataOwned: () => lock.assertOwned() };
    await writeFile(base.paths.ownershipPath, JSON.stringify({ schemaVersion: 2, slotId, sourceRoot: source.root,
      configPath: source.configPath, repository: config.git.repository, sourceIdentity: base.paths.sourceIdentity, slotIdentity: base.paths.slotIdentity }));
    await store.writeAnchor({ schemaVersion: 2, slotId, slotPath: base.paths.slotRoot, sourceRoot: source.root, configPath: source.configPath });
    return { root: base.root, cwd: source.root, sha, config, slot, source, dispose: base.dispose };
  } catch (error) { await base.dispose(); throw error; }
}
