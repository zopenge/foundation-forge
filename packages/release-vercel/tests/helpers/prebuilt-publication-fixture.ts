import { afterEach, expect, vi } from 'vitest';
import { prebuiltPhaseFixture } from './prebuilt-phase-fixture.js';
import { prebuiltFixture } from './prebuilt-fixture.js';
import type { ReleaseTransport } from '../../src/contracts.js';
import { completionPhaseFixture } from './completion-phase-fixture.js';
import { admitCompletionSlot } from '../../src/node/completion-history.js';
import { managedRuns } from './managed-runs.js';
import * as source from '../../src/node/source.js';
import * as git from '../../src/node/git.js';
import * as checkout from '../../src/node/managed-checkout.js';
import * as paths from '../../src/node/managed-paths.js';
import { Execution } from '../../src/node/execution.js';
import * as recovery from '../../src/node/managed-recovery.js';
import { observePrebuiltCandidate } from '../../src/node/prebuilt-recovery.js';

vi.mock('../../src/node/source.js', async original => ({ ...await original<typeof source>() }));
vi.mock('../../src/node/git.js', async original => ({ ...await original<typeof git>() }));
vi.mock('../../src/node/managed-recovery.js', async original => ({ ...await original<typeof recovery>() }));
vi.mock('../../src/node/managed-checkout.js', async original => ({ ...await original<typeof checkout>() }));
// paths 与 recovery 互相引用；先注册替身，再在调用时加载路径检查，避免循环中捕获原 openManagedSlot。
vi.mock('../../src/node/managed-paths.js', () => ({
  openManagedSlot: vi.fn<typeof paths.openManagedSlot>(),
  assertManagedPaths: async (...args: Parameters<typeof paths.assertManagedPaths>) =>
    (await vi.importActual<typeof paths>('../../src/node/managed-paths.js')).assertManagedPaths(...args),
  assertManagementUntracked: async (...args: Parameters<typeof paths.assertManagementUntracked>) =>
    (await vi.importActual<typeof paths>('../../src/node/managed-paths.js')).assertManagementUntracked(...args),
  resolveManagedPaths: async (...args: Parameters<typeof paths.resolveManagedPaths>) =>
    (await vi.importActual<typeof paths>('../../src/node/managed-paths.js')).resolveManagedPaths(...args),
}));

const boundary = vi.hoisted(() => ({ preparing: false, current: undefined as Awaited<ReturnType<typeof prebuiltPhaseFixture>> | undefined }));
// 仅来源/checkout 与发布命令为阶段输入；公开协调器、制品、锁、回执、观察、归档及恢复均执行生产实现。
// BoundaryExecution 拒绝未知命令，不产生合成 identity/scope/closure；Native 完整接线另有成功代表。
vi.mock('../../src/node/publication.js', async original => {
  const actual = await original<typeof import('../../src/node/publication.js')>();
  return { ...actual, publishCandidate: async (...[context, command]: Parameters<typeof actual.publishCandidate>) => {
    if (boundary.preparing) return actual.publishCandidate(context, command);
    const value = boundary.current;
    if (!value || !context.prebuilt) throw new Error('owned prebuilt phase required');
    const managed = context.prebuilt;
    if (!managed.state && value.engine.prebuilt.state) await managed.save(value.engine.prebuilt.state);
    if (command === 'publish' && value.config.completion) {
      // completion 从已封存的发布阶段开始；再次 freeze 会合法地替换 manifest 身份，不能跨此边界重用输入。
      await context.stage('promote');
      return (await observePrebuiltCandidate(context.config, managed.state, value.transport)).deployment;
    }
    return actual.publishCandidate({ ...context, execution: value.engine.context.execution,
      prebuilt: { ...managed, executionAt: value.engine.prebuilt.executionAt,
        save: async state => { await value.engine.prebuilt.save(state); await managed.save(state); } } }, command);
  } };
});

const owned: Awaited<ReturnType<typeof prebuiltPhaseFixture>>[] = [];
const runs = managedRuns();
afterEach(async () => {
  try {
    await runs.close();
    for (const method of ['git', 'streamGit'] as const) expect(Execution.prototype[method]).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks(); boundary.current = undefined;
    for (const value of owned.splice(0)) await value.dispose();
  }
});

async function coordinator<T extends Awaited<ReturnType<typeof prebuiltPhaseFixture>>>(value: T) {
  owned.push(value); boundary.current = value;
  let engine = value.engine, candidateSha = value.sha, selectedTransport = value.transport;
  const engines = [engine], sources = new Map([[value.sha, value.source]]);
  // 同一云边界与别名绑定跨候选保留；每份制品及部署响应仍独立，绝不复用上一候选的prebuilt状态。
  const transport: ReleaseTransport = {
    api: (...args) => selectedTransport.api(...args), buildInfo: (...args) => selectedTransport.buildInfo(...args),
    promote: async (...args) => {
      if (!selectedTransport.promote) throw new Error('controlled promotion required');
      await selectedTransport.promote(...args);
    }, ...(value.transport.versionAlias ? { versionAlias: value.transport.versionAlias } : {}) };
  const unexpected: string[] = [];
  for (const method of ['git', 'streamGit'] as const) vi.spyOn(Execution.prototype, method).mockImplementation(async () => {
    const error = new Error(`unexpected phase ${method}`); unexpected.push(error.stack ?? error.message); throw error;
  });
  const assertSource = (candidate: typeof value.source) => { expect(candidate).toEqual(sources.get(candidate.sha)); };
  vi.spyOn(source, 'freezeManagedSource').mockImplementation(async (cwd, path) => {
    expect(cwd).toBe(value.cwd); expect(path).toBe(value.source.configPath); return value.source;
  });
  vi.spyOn(source, 'inspectCommitTree').mockImplementation(async candidate => {
    expect(candidate.sha).toMatch(/^[a-f0-9]{40}$/u);
    expect(candidate).toEqual({ ...value.source, sha: candidate.sha }); sources.set(candidate.sha, candidate);
  });
  vi.spyOn(source, 'assertSourceFrozen').mockImplementation(async candidate => { assertSource(candidate); });
  vi.spyOn(source, 'readCommittedConfig').mockImplementation(async (execution, sha, path) => {
    expect(execution.cwd).toBe(value.cwd); expect(sources.has(sha)).toBe(true); expect(path).toBe(value.source.configPath);
    return { config: value.config, oid: value.source.configBlobOid, bytes: Buffer.from(JSON.stringify(value.config)) };
  });
  vi.spyOn(recovery, 'assertHistoricalSource').mockImplementation(async candidate => { assertSource(candidate); });
  vi.spyOn(git, 'assertRepository').mockImplementation(async execution => { expect(execution.cwd).toBe(value.cwd); });
  vi.spyOn(checkout, 'prepareCheckout').mockResolvedValue(undefined);
  vi.spyOn(checkout, 'prepareEnvironment').mockResolvedValue(undefined);
  vi.spyOn(checkout, 'assertCheckoutFrozen').mockImplementation(async session => { assertSource(session.slot.source); });
  vi.mocked(paths.openManagedSlot).mockImplementation(async (candidate, execution, command) => {
    assertSource(candidate); expect(execution.cwd).toBe(value.cwd);
    if (command !== 'publish' && command !== 'verify') throw new Error('unexpected phase coordinator command');
    const slot = value.session.slot;
    const resume = await admitCompletionSlot(slot.paths, slot.slotId, candidate, command);
    if (candidate.sha !== candidateSha) {
      if (!value.config.delivery || value.config.completion) throw new Error('only prebuilt publication phases may change candidate');
      const next = await prebuiltFixture({ sha: candidate.sha, config: { ...value.config, delivery: value.config.delivery }, root: engine.root,
        deployment: { id: 'dpl_candidate2', hostname: 'candidate2.vercel.app' } });
      Object.assign(next.hooks, engine.hooks); engine = next; engines.push(next); candidateSha = candidate.sha;
      const cloud = next.context.transport; if (!cloud?.promote) throw new Error('controlled phase cloud required');
      selectedTransport = { ...cloud, promote: async (...args) => { await cloud.promote?.(...args); value.hooks.promote?.(); } };
      boundary.current = { ...value, engine: next };
    }
    await value.next(command, candidate.sha);
    return { ...value.session.slot, ...(resume ? { completionResume: resume } : {}) };
  });
  // 初始阶段 session 只准备目录和锁，不是未完成的公开发布；首个协调器自行写入其真实意图。
  value.session.state.status = 'closed'; await value.session.persist(); await value.session.slot.lock.release();
  return { ...value, transport, get session() { return value.session; }, get engine() { return engine; },
    creates: async () => engines.reduce((total, item) => total + item.counts().creates, 0),
    unexpected,
    promotions: () => engines.reduce((total, item) => total + item.counts().promotions, 0),
    get paths() { return engine.trace.filter(item => item.startsWith('api:')).map(item => item.slice(4)); } };
}

async function fixture(withAlias = false) { return coordinator(await prebuiltPhaseFixture({ withAlias })); }
async function completionFixture(mode = 'fail') {
  boundary.preparing = true;
  try { return await coordinator(await completionPhaseFixture({ mode })); }
  finally { boundary.preparing = false; }
}

export { fixture, completionFixture, runs };
