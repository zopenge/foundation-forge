import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { CommandRunner } from '@openge/forge-command-runner';
import { Execution, foregroundGitArguments } from '../src/node/execution.js';
import { assertCheckoutFrozen } from '../src/node/managed-checkout.js';
import { createManagedSession } from '../src/node/managed-process.js';
import { hasVerifiedManagedClosure } from '../src/node/managed-closure.js';
import { inspectManagedRecovery } from '../src/node/managed-recovery.js';
import { restoreManagedTerminal } from '../src/node/managed-terminal.js';
import { ReleaseError } from '../src/node/errors.js';
import { managedSessionFixture } from './helpers/managed-session-fixture.js';
import { createScriptedCommandRunner } from './helpers/scripted-command-runner.js';

// 仅此文件提供命令协议输入；合成身份/关闭结果不是任何真实OS进程停止的证据。
const dispatch = vi.hoisted(() => ({ runner: undefined as CommandRunner | undefined }));
vi.mock('@openge/forge-command-runner/node', async importOriginal => ({
  ...await importOriginal<typeof import('@openge/forge-command-runner/node')>(),
  createNodeCommandRunner: () => {
    if (!dispatch.runner) throw new Error('observation component runner is not configured');
    return dispatch.runner;
  },
}));
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof filesystem>() }));

type Fixture = Awaited<ReturnType<typeof managedSessionFixture>>;
type Session = Awaited<ReturnType<typeof createManagedSession>>;
const fixtures: { fixture: Fixture; session?: Session; runner?: ReturnType<typeof createScriptedCommandRunner>; unknown?: boolean }[] = [];
// 恢复协议只接收明确的组件身份观察，真实PID reader由进程/崩溃集成测试承担。
const absentReader = { readIdentity: async () => ({ status: 'ABSENT' as const }) };

async function prepared({ signal, queries = 5 }: { signal?: AbortSignal; queries?: number } = {}) {
  const fixture = await managedSessionFixture(), slot = fixture.slot;
  const entry: (typeof fixtures)[number] = { fixture }; fixtures.push(entry);
  await mkdir(slot.paths.checkoutRoot);
  const configBytes = JSON.stringify(fixture.config);
  await writeFile(resolve(slot.paths.checkoutRoot, 'release.config.json'), configBytes);
  // 独立列出完整输入，不能用生产计划自动生成期望。
  const calls = [
    { args: ['rev-parse', '--show-toplevel'], stdout: slot.paths.checkoutRoot },
    { args: ['config', '--get-regexp', '^remote\\.origin\\.(url|pushurl)$'], stdout: `remote.origin.url ${fixture.source.fetchUrl}\n` },
    { args: ['status', '--porcelain=v2', '--branch', '--no-ahead-behind', '-z', '--untracked-files=all'], stdout: `# branch.oid ${fixture.sha}\0# branch.head dev\0` },
    { args: ['rev-parse', '--verify', '--quiet', `${fixture.sha}:release.config.json`], stdout: fixture.source.configBlobOid },
    { args: ['cat-file', 'blob', fixture.source.configBlobOid], stdout: configBytes },
  ].slice(0, queries).map(value => ({ ...value, command: 'git', args: [...foregroundGitArguments, ...value.args], cwd: slot.paths.checkoutRoot }));
  const runner = createScriptedCommandRunner({ calls }); dispatch.runner = runner.runner;
  entry.runner = runner;
  const session = await createManagedSession(slot, 'check', signal); entry.session = session;
  return { fixture, slot, session, runner, entry };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const entry of fixtures.splice(0)) {
    try {
      entry.runner?.assertConsumed();
      if (entry.session && !entry.unknown) { await entry.session.assertStopped(); await entry.fixture.slot.lock.release(); }
    } finally { await entry.fixture.dispose(); }
  }
  dispatch.runner = undefined;
});

it('组件：查询间取消保持失败且不启动后续计划', async () => {
  const controller = new AbortController(), { slot, session } = await prepared({ signal: controller.signal, queries: 1 });
  const original = Execution.prototype.git;
  vi.spyOn(Execution.prototype, 'git').mockImplementation(async function (this: Execution, args) {
    const result = await original.call(this, args);
    if (this.cwd === slot.paths.checkoutRoot && args[1] === '--show-toplevel') controller.abort();
    return result;
  });
  await expect(assertCheckoutFrozen(session)).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(session.state.processes.at(-1)).toHaveProperty('observations.length', 1);
  await session.assertStopped();
});

it('组件：授权前取消保留受控停止输入及原错误分类', async () => {
  const controller = new AbortController(), { session } = await prepared({ signal: controller.signal, queries: 1 });
  const sample = session.budget.sample.bind(session.budget); let cancelled = false;
  vi.spyOn(session.budget, 'sample').mockImplementation(async () => {
    await sample();
    if (!cancelled && session.state.processes.at(-1)?.observations?.at(-1)?.status === 'identified') {
      cancelled = true; controller.abort();
    }
  });
  await expect(assertCheckoutFrozen(session)).rejects.toMatchObject({ code: 'PROCESS_STATE_UNKNOWN', details: { reason: 'START_CANCELLED' } });
  expect(cancelled).toBe(true);
  expect(session.state.processes.at(-1)).toMatchObject({ status: 'stopped', observationComplete: true });
  expect(session.state.processes.at(-1)?.observations).toHaveLength(1);
  expect(session.state.processes.at(-1)?.observations?.[0]?.closure).toMatchObject({ requestedTermination: 'abort', ownedScope: { empty: true } });
  await session.assertStopped();
});

it('组件：独立证明写入失败时整批保持UNKNOWN', async () => {
  const { slot, session, entry } = await prepared(), original = Execution.prototype.streamGit;
  vi.spyOn(Execution.prototype, 'streamGit').mockImplementation(async function (this: Execution, args, consume, exits) {
    await original.call(this, args, consume, exits);
    if (this.cwd === slot.paths.checkoutRoot && args[0] === 'cat-file') {
      await writeFile(resolve(slot.paths.slotRoot, '.terminal.json.next'), 'fixture-owned blocked proof', { flag: 'wx' });
    }
  });
  entry.unknown = true;
  await expect(assertCheckoutFrozen(session)).rejects.toMatchObject({ code: 'PROCESS_STATE_UNKNOWN' });
  expect(session.state.processes.at(-1)).toMatchObject({ kind: 'checkout-observation', status: 'unknown', observationComplete: false });
  expect(session.state.processes.at(-1)).not.toHaveProperty('terminalSha256');
  const inputs = session.state.processes.at(-1)?.observations ?? [];
  expect(inputs).toHaveLength(5); expect(inputs.every(hasVerifiedManagedClosure)).toBe(true);
  await expect(session.assertStopped()).rejects.toMatchObject({ code: 'PROCESS_STATE_UNKNOWN' });
  expect(await inspectManagedRecovery(session.state, slot.paths, undefined, absentReader)).toMatchObject({ processes: 'unknown' });
  await expect(readFile(resolve(slot.paths.slotRoot, 'terminal.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(JSON.parse(await readFile(slot.paths.statePath, 'utf8')).processes.at(-1)).toMatchObject({ status: 'unknown', observationComplete: false });
});

it('组件：完整state rename失败仍可只读恢复耐久停止输入', async () => {
  const { slot, session } = await prepared(), rename = filesystem.rename;
  vi.spyOn(filesystem, 'rename').mockImplementation(async (from, to) => {
    if (to === slot.paths.statePath && session.state.processes.at(-1)?.terminalSha256) throw Object.assign(new Error('fixture state failure'), { code: 'EIO' });
    await rename(from, to);
  });
  await expect(assertCheckoutFrozen(session)).rejects.toMatchObject({ code: 'PROCESS_STATE_UNKNOWN' });
  vi.restoreAllMocks();
  const disk = await slot.store.read(); if (!disk) throw new Error('missing disk state');
  expect(disk.processes.at(-1)).toMatchObject({ status: 'intent', observationComplete: false, observations: [] });
  const restored = await restoreManagedTerminal(slot.paths, disk);
  expect(restored.state.processes.at(-1)).toMatchObject({ status: 'closed', observationComplete: true, observations: expect.any(Array) });
  expect(restored.state.processes.at(-1)?.observations).toHaveLength(5);
  expect(await readFile(slot.paths.statePath, 'utf8')).toBe(`${JSON.stringify(disk)}\n`);
  await session.assertStopped();
});

it('组件：旧批次证明不能关闭新的耐久意图', async () => {
  const { slot, session } = await prepared(); await assertCheckoutFrozen(session);
  const previous = session.state.processes.at(-1)?.id, original = Execution.prototype.git; let inspected = false;
  vi.spyOn(Execution.prototype, 'git').mockImplementation(async function (this: Execution, args) {
    if (this.cwd === slot.paths.checkoutRoot && args[1] === '--show-toplevel') {
      const disk = await slot.store.read(); if (!disk) throw new Error('missing disk intent');
      const restored = await restoreManagedTerminal(slot.paths, disk);
      expect(restored.state.processes.at(-1)?.id).not.toBe(previous);
      expect(restored.state.processes.at(-1)).toMatchObject({ status: 'intent', observationComplete: false });
      expect(await inspectManagedRecovery(restored.state, slot.paths, undefined, absentReader)).toMatchObject({ processes: 'unknown' });
      inspected = true; throw new ReleaseError('CANDIDATE_CHANGED');
    }
    return original.call(this, args);
  });
  await expect(assertCheckoutFrozen(session)).rejects.toMatchObject({ code: 'CANDIDATE_CHANGED' }); expect(inspected).toBe(true);
});

it('组件：变更argv在创建命令scope前被拒绝', async () => {
  const { slot, session, runner } = await prepared({ queries: 0 }), original = Execution.prototype.git;
  vi.spyOn(Execution.prototype, 'git').mockImplementation(async function (this: Execution, args) {
    return original.call(this, this.cwd === slot.paths.checkoutRoot && args[1] === '--show-toplevel'
      ? ['config', 'fixture.batch-escape', 'must-not-write'] : args);
  });
  await expect(assertCheckoutFrozen(session)).rejects.toMatchObject({ code: 'PROCESS_STATE_UNKNOWN', details: { reason: 'OBSERVATION_PLAN' } });
  expect(session.state.processes.at(-1)?.observations).toHaveLength(0);
  expect(runner.observed).toHaveLength(0);
});

it('组件：首个解析错误优先，后续查询不得启动', async () => {
  const { slot, session } = await prepared({ queries: 1 }), original = Execution.prototype.git;
  vi.spyOn(Execution.prototype, 'git').mockImplementation(async function (this: Execution, args) {
    const output = await original.call(this, args);
    return this.cwd === slot.paths.checkoutRoot && args[1] === '--show-toplevel' ? slot.paths.slotRoot : output;
  });
  await expect(assertCheckoutFrozen(session)).rejects.toMatchObject({ code: 'GIT_REPOSITORY', details: { reason: 'ROOT_MISMATCH' } });
  expect(session.state.processes.at(-1)?.observations).toHaveLength(1); await session.assertStopped();
});

it('组件：已封印批次拒绝跨await迟到的查询', async () => {
  const { slot, session } = await prepared({ queries: 0 }), assertOwned = slot.lock.assertOwned.bind(slot.lock);
  let release: (() => void) | undefined, entered: (() => void) | undefined, delayed = false, gate = false;
  const blocked = new Promise<void>(accept => { release = accept; }), waiting = new Promise<void>(accept => { entered = accept; });
  vi.spyOn(slot.lock, 'assertOwned').mockImplementation(async () => {
    await assertOwned(); if (gate && !delayed) { delayed = true; entered?.(); await blocked; }
  });
  let pending: Promise<{ error?: unknown }> | undefined;
  try {
    await expect(session.execution.observeCheckout(async () => {
      gate = true;
      pending = session.execution.git(['rev-parse', '--show-toplevel']).then(() => ({}), (error: unknown) => ({ error }));
      await waiting; throw new ReleaseError('CANDIDATE_CHANGED');
    })).rejects.toMatchObject({ code: 'CANDIDATE_CHANGED' });
  } finally { release?.(); }
  expect(await pending).toMatchObject({ error: { code: 'PROCESS_STATE_UNKNOWN', details: { reason: 'OBSERVATION_PLAN' } } });
  expect(session.state.processes.at(-1)?.observations).toHaveLength(0); await session.assertStopped();
});
