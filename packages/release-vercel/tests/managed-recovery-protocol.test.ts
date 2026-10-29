import { createHash } from 'node:crypto';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runRelease } from '../src/node.js';
import { Execution } from '../src/node/execution.js';
import { ReleaseError } from '../src/node/errors.js';
import * as sourceBoundary from '../src/node/source.js';
import * as gitBoundary from '../src/node/git.js';
import { openManagedSlot } from '../src/node/managed-paths.js';
import { createManagedSession } from '../src/node/managed-process.js';
import { inspectManagedRecovery, selectManagedPublication } from '../src/node/managed-recovery.js';
import type { ManagedReceipt, ManagedState } from '../src/node/release-context.js';
import type { ReleaseTransport } from '../src/contracts.js';
import { managedSessionFixture } from './helpers/managed-session-fixture.js';

vi.mock('../src/node/source.js', async importOriginal => ({ ...await importOriginal<typeof sourceBoundary>() }));
vi.mock('../src/node/git.js', async importOriginal => ({ ...await importOriginal<typeof gitBoundary>() }));

const fixtures: Awaited<ReturnType<typeof managedSessionFixture>>[] = [];
afterEach(async () => {
  try { if (vi.isMockFunction(Execution.prototype.run)) expect(Execution.prototype.run).not.toHaveBeenCalled(); }
  finally { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) await f.dispose(); }
});
const transport: ReleaseTransport = { api: async path => {
  if (path.startsWith('/v9/projects')) return { id: 'prj_fixture', accountId: 'team_fixture', link: { type: 'github', org: 'fixture', repo: 'repository', repoId: 101, productionBranch: 'main', gitCredentialId: 'fixture', deployHooks: [] } };
  if (path.startsWith('/v6/deployments')) return { deployments: [] };
  throw new Error(`unexpected recovery component API: ${path}`);
}, buildInfo: async () => { throw new Error('recovery/status must not execute acceptance'); } };

// 来源与远端是严格的组件输入；路径身份、锁、当前schema3、回执、归档和PID查询均执行生产实现。
// 空命令集合不生成identity/scope/closure，也不声称证明任何真实子进程已经停止。
const fixture = async () => {
  const f = await managedSessionFixture(); fixtures.push(f);
  const session = await createManagedSession(f.slot, 'publish');
  session.state.status = 'closed'; session.state.stage = 'checks'; await session.persist();
  const receipt: ManagedReceipt = { schemaVersion: 2, slotId: f.slot.slotId, source: f.source,
    report: { schemaVersion: 2, command: 'publish', runId: f.slot.runId, sourceRoot: f.cwd, configPath: f.source.configPath,
      executionRoot: f.slot.paths.checkoutRoot, slotId: f.slot.slotId, ok: false, candidateSha: f.sha, configSha256: f.source.configSha256,
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), stage: 'checks', steps: [],
      error: { code: 'CHECK_FAILED', details: { reason: 'SELECTION_COMPONENT' } },
      effects: { developmentPush: 'not-attempted', releasePush: 'not-attempted' } } };
  await f.slot.store.writeReceipt('publish', receipt);
  await f.slot.store.writeAnchor({ schemaVersion: 2, slotId: f.slot.slotId, slotPath: f.slot.paths.slotRoot, sourceRoot: f.cwd,
    configPath: f.source.configPath, latestPublish: { sha: f.sha, runId: f.slot.runId, configSha256: f.source.configSha256 } });
  await f.slot.lock.release();
  const bytes = Buffer.from(JSON.stringify(f.config)), initial = '1'.repeat(40);
  vi.spyOn(sourceBoundary, 'readCommittedConfig').mockImplementation(async (execution, sha, path) => {
    expect(execution.cwd).toBe(f.cwd); expect(sha).toBe(f.sha); expect(path).toBe(f.source.configPath);
    return { config: f.config, bytes, oid: f.source.configBlobOid };
  });
  vi.spyOn(gitBoundary, 'assertRepository').mockImplementation(async execution => { expect(execution.cwd).toBe(f.cwd); });
  vi.spyOn(gitBoundary, 'remoteRefs').mockImplementation(async execution => {
    expect(execution.cwd).toBe(f.cwd); return { dev: initial, main: initial };
  });
  vi.spyOn(Execution.prototype, 'run').mockImplementation(async name => { throw new Error(`unexpected recovery component application command: ${name}`); });
  const ignore = Buffer.from('.tmp/\n'), ignoreOid = createHash('sha1').update(Buffer.from(`blob ${ignore.length}\0`)).update(ignore).digest('hex');
  await writeFile(resolve(f.cwd, '.gitignore'), ignore);
  const git = vi.spyOn(Execution.prototype, 'git').mockImplementation(async function (this: Execution, args) {
    expect(this.cwd).toBe(f.cwd);
    if (JSON.stringify(args) === JSON.stringify(['merge-base', '--is-ancestor', initial, f.sha])) return '';
    if (JSON.stringify(args) === JSON.stringify(['merge-base', '--is-ancestor', f.sha, initial])) throw new ReleaseError('GIT_FAILED', { exitCode: 1 });
    if (JSON.stringify(args) === JSON.stringify(['rev-parse', '--verify', `${f.sha}:.gitignore`])) return ignoreOid;
    if (args.length === 7 && JSON.stringify(args.slice(0, 6)) === JSON.stringify(['-c', 'core.quotepath=false', 'check-ignore', '--no-index', '-v', '--'])
      && ['.tmp/release-slot/', '.tmp/forge-vercel-release/managed.json'].includes(args[6] ?? '')) return `.gitignore:1:.tmp/\t${args[6]}`;
    throw new Error(`unexpected recovery component Git query: ${JSON.stringify(args)}`);
  });
  vi.spyOn(Execution.prototype, 'streamGit').mockImplementation(async function (this: Execution, args, consume) {
    expect(this.cwd).toBe(f.cwd);
    const pathspec = process.platform === 'win32' ? ':(icase,literal).tmp' : ':(literal).tmp';
    if (JSON.stringify(args) === JSON.stringify(['ls-files', '--cached', '--with-tree=HEAD', '-z', '--', pathspec])) return;
    if (JSON.stringify(args) === JSON.stringify(['ls-tree', '-rz', f.sha, '--', '.tmp/release-slot'])) return;
    if (JSON.stringify(args) === JSON.stringify(['cat-file', 'blob', ignoreOid])) { consume(ignore); return; }
    throw new Error(`unexpected recovery component Git stream: ${JSON.stringify(args)}`);
  });
  return { ...f, state: session.state, receipt, initial, git, execution: new Execution(f.cwd, f.config, undefined, []) };
};

it('does not change the publish selection when a later check receipt is written', async () => {
  const f = await fixture(), slot = await openManagedSlot(f.source, f.execution);
  await slot.store.writeReceipt('check', { ...f.receipt, report: { ...f.receipt.report, command: 'check', runId: slot.runId } }); await slot.lock.release();
  const selected = await selectManagedPublication(f.cwd, 'release.config.json');
  expect(selected.report.command).toBe('publish'); expect(selected.report.runId).toBe(f.receipt.report.runId);
});
it('rejects an explicit SHA that has no matching known publish receipt', async () => {
  const f = await fixture();
  await expect(selectManagedPublication(f.cwd, 'release.config.json', f.initial)).rejects.toMatchObject({ code: 'RECEIPT_SHA_MISMATCH' });
});
it('observes a live run owner without stealing its lock', async () => {
  const f = await fixture(), slot = await openManagedSlot(f.source, f.execution);
  const state: ManagedState = { ...f.state, runId: slot.runId, coordinator: slot.coordinator, status: 'running' };
  const before = await readFile(slot.paths.lockPath);
  expect(await inspectManagedRecovery(state, slot.paths)).toMatchObject({ owner: 'active', processes: 'closed', knownCount: 0 });
  expect(await readFile(slot.paths.lockPath)).toEqual(before); await slot.lock.release();
});
it('keeps missing command identity unknown even when the recorded owner run is closed', async () => {
  const f = await fixture();
  f.state.processes.push({ id: f.slot.runId, name: 'crash-gap', status: 'intent', descendants: [], observationComplete: false });
  f.state.effects.developmentPush = 'unknown';
  expect(await inspectManagedRecovery(f.state, f.slot.paths)).toMatchObject({ processes: 'unknown', knownCount: 0 });
});
it.each([false, true])('recognizes an old coordinator instance is gone without inferring child closure: %s', async incomplete => {
  const f = await fixture();
  if (incomplete) f.state.processes.push({ id: f.slot.runId, name: 'unproved-child', status: 'intent', observationComplete: false, descendants: [] });
  const observation = await inspectManagedRecovery(f.state, f.slot.paths, undefined, {
    readIdentity: async request => ({ status: 'FOUND', identity: { pid: request.pid, startToken: 'a-different-instance' } }),
  });
  expect(observation).toMatchObject({ owner: 'inactive', processes: incomplete ? 'unknown' : 'closed' });
});
it('refuses verification when the frozen checkout is missing', async () => {
  const f = await fixture();
  const report = await runRelease({ cwd: f.cwd, command: 'verify' });
  expect(report).toMatchObject({ ok: false, candidateSha: f.sha, error: { code: 'RECOVERY_REQUIRED', details: { reason: 'CHECKOUT_MISSING' } } });
  await expect(readFile(resolve(f.slot.paths.checkoutRoot, 'package.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it.each([false, true])('recovers an already closed run without installation or Git push, pending internal link: %s', async pendingLink => {
  const f = await fixture(), before = await readFile(f.slot.paths.statePath);
  if (pendingLink) {
    const modules = resolve(f.slot.paths.checkoutRoot, 'node_modules'); await mkdir(modules, { recursive: true });
    await symlink(resolve(modules, '.pnpm/pending/node_modules/dependency'), resolve(modules, 'dependency'), 'junction');
  }
  const report = await runRelease({ cwd: f.cwd, command: 'recover', transport });
  expect(report, JSON.stringify(report.error)).toMatchObject({ ok: true, command: 'recover', candidateSha: f.sha, processes: { status: 'closed' } });
  expect(report.steps.some(step => step.name === 'install' || step.name.startsWith('check:'))).toBe(false);
  expect(await readFile(f.slot.paths.statePath)).toEqual(before);
  const reused = await openManagedSlot(f.source, f.execution);
  expect(reused.slotId).toBe(f.slot.slotId); await reused.lock.release();
  expect(f.git.mock.calls.some(([args]) => ['push', 'fetch'].includes(args[0] ?? ''))).toBe(false);
});
it.each([true, false])('does not resolve historical push uncertainty from stale before observations: %s', async recovered => {
  const f = await fixture();
  const report = { ...f.receipt.report, effects: { developmentPush: 'not-attempted' as const, releasePush: 'unknown' as const },
    ...(recovered ? { recovery: { candidateSha: f.sha, reportPath: 'fixture', nextCommand: 'fixture', observation: {
      owner: 'inactive' as const, processes: 'closed' as const, observedAt: new Date().toISOString(),
      releaseRef: { sha: f.initial, relation: 'before' as const } } } } : {}) };
  const saved = JSON.stringify({ ...f.receipt, report }); await writeFile(resolve(f.slot.paths.slotRoot, 'latest-publish.json'), saved);
  await writeFile(f.slot.paths.statePath, JSON.stringify({ ...f.state, command: 'check', runId: '00000000-0000-4000-8000-000000000001' }));
  const status = await runRelease({ cwd: f.cwd, command: 'status', transport });
  expect(status, JSON.stringify(status.error)).toMatchObject({ ok: false, effects: { releasePush: 'unknown' }, error: { code: 'RECOVERY_REQUIRED' } });
  expect(status.recovery?.observation?.releaseRef).toEqual({ sha: f.initial, relation: 'before' });
  expect(await readFile(resolve(f.slot.paths.slotRoot, 'latest-publish.json'), 'utf8')).toBe(saved);
});
