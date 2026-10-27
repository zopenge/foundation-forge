import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { classifyRemoteRef, inspectManagedRecovery, runManagedReceiptCommand, selectManagedPublication } from '../src/node/managed-recovery.js';
import { committedFixtureSource } from './helpers/committed-fixture-source.js';
import { openManagedSlot } from '../src/node/managed-paths.js';
import { git, managedFixture } from './helpers/managed-fixture.js';
import type { ManagedReceipt, ManagedState } from '../src/node/release-context.js';
import type { ReleaseTransport } from '../src/contracts.js';
import { runRelease } from '../src/node.js';
import { assertManagedRemoteSettled } from '../src/node/managed-remote-state.js';

const fixtures: Awaited<ReturnType<typeof managedFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.dispose(); });
const fixture = async () => {
  const f = await managedFixture(); fixtures.push(f);
  const declared = 'https://github.com/fixture/repository.git';
  git(f.cwd, 'config', `url.${f.remote.replaceAll('\\', '/')}.insteadOf`, declared);
  git(f.cwd, 'remote', 'set-url', 'origin', declared); Object.assign(f.config.git, { repository: 'github.com/fixture/repository' });
  await writeFile(resolve(f.cwd, 'release.config.json'), JSON.stringify(f.config)); const sha = f.commit();
  const source = await committedFixtureSource(f, sha), slot = await openManagedSlot(source, f.execution);
  const receipt: ManagedReceipt = { schemaVersion: 2, slotId: slot.slotId, source,
    report: { schemaVersion: 2, command: 'publish', runId: slot.runId, sourceRoot: source.root, configPath: source.configPath,
      executionRoot: slot.paths.checkoutRoot, slotId: slot.slotId, ok: false, candidateSha: source.sha, configSha256: source.configSha256,
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), stage: 'checks', steps: [],
      error: { code: 'CHECK_FAILED', details: { reason: 'SELECTION_FIXTURE' } },
      effects: { developmentPush: 'not-attempted', releasePush: 'not-attempted' } } };
  await slot.store.writeReceipt('publish', receipt);
  await slot.store.writeState({ schemaVersion: 2, slotId: slot.slotId, runId: slot.runId, source, command: 'publish', coordinator: slot.coordinator,
    stage: 'checks', status: 'closed', processes: [], effects: { developmentPush: 'not-attempted', releasePush: 'not-attempted' } });
  await slot.store.writeAnchor({ schemaVersion: 2, slotId: slot.slotId, slotPath: slot.paths.slotRoot, sourceRoot: source.root,
    configPath: source.configPath, latestPublish: { sha: source.sha, runId: slot.runId, configSha256: source.configSha256 } });
  await slot.lock.release();
  return { ...f, source, slot, receipt };
};
it('selects the frozen publish receipt after later source/config changes', async () => {
  const f = await fixture(); await writeFile(resolve(f.cwd, 'release.config.json'), '{"later":"configuration"}'); f.commit();
  const selected = await selectManagedPublication(f.cwd, 'release.config.json');
  expect(selected.source.sha).toBe(f.source.sha); expect(selected.source.config).toEqual(f.config);
});
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
it('rejects a source remote change instead of silently retargeting a historical receipt', async () => {
  const f = await fixture(); git(f.cwd, 'remote', 'set-url', 'origin', resolve(f.root, 'different.git'));
  await expect(selectManagedPublication(f.cwd, 'release.config.json')).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
});
it('rejects a replaced slot anchor', async () => {
  const f = await fixture();
  const anchor = JSON.parse(await readFile(f.slot.paths.anchorPath, 'utf8')) as Record<string, unknown>;
  await writeFile(f.slot.paths.anchorPath, JSON.stringify({ ...anchor, slotId: '00000000-0000-0000-0000-000000000000' }));
  await expect(selectManagedPublication(f.cwd, 'release.config.json')).rejects.toMatchObject({ code: 'SLOT_STATE' });
});
it('observes a live run owner without stealing its lock', async () => {
  const f = await fixture(), slot = await openManagedSlot(f.source, f.execution);
  const state: ManagedState = { schemaVersion: 2, slotId: slot.slotId, runId: slot.runId, source: f.source, command: 'publish',
    coordinator: slot.coordinator, status: 'running', stage: 'checks', processes: [], effects: { developmentPush: 'not-attempted', releasePush: 'not-attempted' } };
  const before = await readFile(slot.paths.lockPath);
  expect(await inspectManagedRecovery(state, slot.paths)).toMatchObject({ owner: 'active', processes: 'closed', knownCount: 0 });
  expect(await readFile(slot.paths.lockPath)).toEqual(before); await slot.lock.release();
});
it('keeps missing command identity unknown even when the recorded owner run is closed', async () => {
  const f = await fixture();
  const state: ManagedState = { schemaVersion: 2, slotId: f.slot.slotId, runId: f.slot.runId, source: f.source, command: 'publish',
    coordinator: f.slot.coordinator, status: 'closed', stage: 'checks', processes: [{ id: f.slot.runId, name: 'crash-gap', status: 'intent', descendants: [], observationComplete: false }],
    effects: { developmentPush: 'unknown', releasePush: 'not-attempted' } };
  expect(await inspectManagedRecovery(state, f.slot.paths)).toMatchObject({ processes: 'unknown', knownCount: 0 });
});
it.each([false, true])('recognizes an old coordinator instance is gone without inferring child closure: %s', async incomplete => {
  const f = await fixture(), state = JSON.parse(await readFile(f.slot.paths.statePath, 'utf8')) as ManagedState;
  if (incomplete) state.processes.push({ id: f.slot.runId, name: 'unproved-child', status: 'intent', observationComplete: false, descendants: [] });
  const observation = await inspectManagedRecovery(state, f.slot.paths, undefined, {
    readIdentity: async request => ({ status: 'FOUND', identity: { pid: request.pid, startToken: 'a-different-instance' } }),
  });
  expect(observation).toMatchObject({ owner: 'inactive', processes: incomplete ? 'unknown' : 'closed' });
});
it('reads historical polling witnesses but never upgrades them to OS closure', async () => {
  const f = await fixture();
  const state: ManagedState = { schemaVersion: 2, slotId: f.slot.slotId, runId: f.slot.runId, source: f.source, command: 'publish', coordinator: f.slot.coordinator,
    status: 'closed', stage: 'checks', effects: { developmentPush: 'not-attempted', releasePush: 'not-attempted' },
    processes: [{ id: f.slot.runId, name: 'legacy-command', status: 'closed', descendants: [], identity: { pid: 123, startToken: 'old-instance' }, observationComplete: true,
      closure: { observedAt: new Date().toISOString(), exitCode: 0, termination: 'exit' } }] };
  await writeFile(f.slot.paths.statePath, JSON.stringify(state));
  expect(await inspectManagedRecovery(state, f.slot.paths, undefined, { readIdentity: async () => ({ status: 'ABSENT' }) })).toMatchObject({ owner: 'inactive', processes: 'unknown' });
  await expect(openManagedSlot(f.source, f.execution)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
});
it('status uses the historical target without changing metadata or creating a checkout', async () => {
  const f = await fixture(); Object.assign(f.config.vercel, { projectId: 'prj_changed' });
  await writeFile(resolve(f.cwd, 'release.config.json'), JSON.stringify(f.config)); f.commit();
  const requests: string[] = [], before = await readFile(f.slot.paths.anchorPath);
  const transport: ReleaseTransport = { api: async path => {
    requests.push(path); return path.startsWith('/v9/projects') ? { id: 'prj_fixture', accountId: 'team_fixture', link: { type: 'github', org: 'fixture', repo: 'repository', repoId: 101, productionBranch: 'main', gitCredentialId: 'fixture', deployHooks: [] } }
      : { deployments: [] };
  }, buildInfo: async () => { throw new Error('status must not execute acceptance'); } };
  const report = await runManagedReceiptCommand({ cwd: f.cwd, command: 'status', transport });
  expect(report).toMatchObject({ candidateSha: f.source.sha, ok: false, error: { code: 'DEPLOYMENT_MISSING' } });
  expect(requests.length).toBeGreaterThan(0); expect(requests.join(' ')).not.toContain('prj_changed');
  expect(await readFile(f.slot.paths.anchorPath)).toEqual(before);
  await expect(readFile(resolve(f.slot.paths.checkoutRoot, 'package.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('classifies real Git ancestry without fetching or changing refs', async () => {
  const f = await fixture();
  await writeFile(resolve(f.cwd, 'source.txt'), 'later'); const later = f.commit();
  const fork = git(f.cwd, 'commit-tree', `${f.initial}^{tree}`, '-p', f.initial, '-m', 'fork');
  expect(await classifyRemoteRef(f.execution, f.source.sha, f.source.sha)).toBe('candidate');
  expect(await classifyRemoteRef(f.execution, f.source.sha, f.initial)).toBe('before');
  expect(await classifyRemoteRef(f.execution, f.source.sha, later)).toBe('superseded');
  expect(await classifyRemoteRef(f.execution, f.source.sha, fork)).toBe('diverged');
  expect(await classifyRemoteRef(f.execution, f.source.sha, 'f'.repeat(40))).toBe('unknown');
  expect(f.ref('main')).toBe(f.initial);
});
it('refuses verification when the frozen checkout is missing', async () => {
  const f = await fixture();
  const report = await runRelease({ cwd: f.cwd, command: 'verify' });
  expect(report).toMatchObject({ ok: false, candidateSha: f.source.sha, error: { code: 'RECOVERY_REQUIRED', details: { reason: 'CHECKOUT_MISSING' } } });
  await expect(readFile(resolve(f.slot.paths.checkoutRoot, 'package.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it.each([false, true])('recovers an already closed run without installation or Git push, pending internal link: %s', async pendingLink => {
  const f = await fixture();
  if (pendingLink) {
    const modules = resolve(f.slot.paths.checkoutRoot, 'node_modules');
    await mkdir(modules, { recursive: true });
    await symlink(resolve(modules, '.pnpm/pending/node_modules/dependency'), resolve(modules, 'dependency'), 'junction');
  }
  const transport: ReleaseTransport = { api: async path => path.startsWith('/v9/projects') ? { id: 'prj_fixture', accountId: 'team_fixture', link: { type: 'github', org: 'fixture', repo: 'repository', repoId: 101, productionBranch: 'main', gitCredentialId: 'fixture', deployHooks: [] } } : { deployments: [] },
    buildInfo: async () => { throw new Error('recover must not run acceptance'); } };
  const report = await runRelease({ cwd: f.cwd, command: 'recover', transport });
  expect(report, JSON.stringify(report.error)).toMatchObject({ ok: true, command: 'recover', candidateSha: f.source.sha, processes: { status: 'closed' } });
  expect(f.ref('dev')).toBe(f.initial); expect(f.ref('main')).toBe(f.initial);
  expect(report.steps.some(step => step.name === 'install' || step.name.startsWith('check:'))).toBe(false);
  const reused = await openManagedSlot(f.source, f.execution);
  expect(reused.slotId).toBe(f.slot.slotId); await reused.lock.release();
});
it('recovers a retained old lock with real closed-process evidence and a pending install junction', async () => {
  const f = await fixture();
  const worker = resolve(import.meta.dirname, 'helpers/closed-managed-worker.mjs');
  const result = await promisify(execFile)(process.execPath, [worker, f.cwd], { cwd: f.root, windowsHide: true, timeout: 120_000, encoding: 'utf8' });
  expect(result.stdout).toBe('closed journal saved');
  const before = JSON.parse(await readFile(f.slot.paths.statePath, 'utf8')) as ManagedState;
  expect(before.status).toBe('running'); expect(before.coordinator.pid).not.toBe(process.pid);
  expect(before.processes).toHaveLength(1);
  expect(before.processes[0]?.closure?.ownedScope).toMatchObject({ status: 'closed', reason: 'normal', empty: true });
  expect(await readFile(f.slot.paths.lockPath, 'utf8')).toContain(before.runId);
  const modules = resolve(f.slot.paths.checkoutRoot, 'node_modules'); await mkdir(modules, { recursive: true });
  await symlink(resolve(modules, '.pnpm/pending/node_modules/dependency'), resolve(modules, 'dependency'), 'junction');
  const transport: ReleaseTransport = { api: async path => path.startsWith('/v9/projects') ? { id: 'prj_fixture', accountId: 'team_fixture', link: { type: 'github', org: 'fixture', repo: 'repository', repoId: 101, productionBranch: 'main', gitCredentialId: 'fixture', deployHooks: [] } } : { deployments: [] },
    buildInfo: async () => { throw new Error('recover must not run acceptance'); } };
  const report = await runRelease({ cwd: f.cwd, command: 'recover', transport });
  expect(report, JSON.stringify(report.error)).toMatchObject({ ok: true, processes: { status: 'closed', knownCount: 1 } });
  await expect(readFile(f.slot.paths.lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  const after = JSON.parse(await readFile(f.slot.paths.statePath, 'utf8')) as ManagedState;
  expect(after).toEqual(before);
  const archive = JSON.parse(await readFile(resolve(f.slot.paths.slotRoot, 'history', `${before.runId}.json`), 'utf8'));
  expect(archive.local).toBe('release-ready'); expect(JSON.parse(archive.snapshot.state)).toEqual(before);
  expect(f.ref('dev')).toBe(f.initial); expect(f.ref('main')).toBe(f.initial);
  const reused = await openManagedSlot(f.source, f.execution);
  expect(reused.slotId).toBe(f.slot.slotId); await reused.lock.release();
});
it('routes public status through the frozen receipt even when current config no longer validates', async () => {
  const f = await fixture(); await writeFile(resolve(f.cwd, 'release.config.json'), '{"later":true}'); f.commit();
  const transport: ReleaseTransport = { api: async path => path.startsWith('/v9/projects') ? { id: 'prj_fixture', accountId: 'team_fixture', link: { type: 'github', org: 'fixture', repo: 'repository', repoId: 101, productionBranch: 'main', gitCredentialId: 'fixture', deployHooks: [] } } : { deployments: [] }, buildInfo: async () => ({}) };
  expect(await runRelease({ cwd: f.cwd, command: 'status', transport })).toMatchObject({ candidateSha: f.source.sha, error: { code: 'DEPLOYMENT_MISSING' } });
});
it.each([true, false])('does not resolve historical push uncertainty from stale before observations: %s', async recovered => {
  const f = await fixture();
  const report = { ...f.receipt.report, effects: { developmentPush: 'not-attempted' as const, releasePush: 'unknown' as const },
    ...(recovered ? { recovery: { candidateSha: f.source.sha, reportPath: 'fixture', nextCommand: 'fixture', observation: {
      owner: 'inactive' as const, processes: 'closed' as const, observedAt: new Date().toISOString(),
      releaseRef: { sha: f.initial, relation: 'before' as const } } } } : {}) };
  const saved = JSON.stringify({ ...f.receipt, report }); await writeFile(resolve(f.slot.paths.slotRoot, 'latest-publish.json'), saved);
  const state = JSON.parse(await readFile(f.slot.paths.statePath, 'utf8')) as ManagedState;
  await writeFile(f.slot.paths.statePath, JSON.stringify({ ...state, command: 'check', runId: '00000000-0000-4000-8000-000000000001' }));
  const transport: ReleaseTransport = { api: async path => path.startsWith('/v9/projects') ? { id: 'prj_fixture', accountId: 'team_fixture', link: { type: 'github', org: 'fixture', repo: 'repository', repoId: 101, productionBranch: 'main', gitCredentialId: 'fixture', deployHooks: [] } } : { deployments: [] }, buildInfo: async () => ({}) };
  const status = await runRelease({ cwd: f.cwd, command: 'status', transport });
  expect(status).toMatchObject({ ok: false, effects: { releasePush: 'unknown' }, error: { code: 'RECOVERY_REQUIRED' } });
  expect(status.recovery?.observation?.releaseRef).toEqual({ sha: f.initial, relation: 'before' });
  expect(await readFile(resolve(f.slot.paths.slotRoot, 'latest-publish.json'), 'utf8')).toBe(saved);
});

it('reports current candidate observations without rewriting an archived unknown push outcome', async () => {
  const f = await fixture(), state = JSON.parse(await readFile(f.slot.paths.statePath, 'utf8')) as ManagedState;
  const effects = { ...state.effects, releasePush: 'unknown' as const };
  await writeFile(f.slot.paths.statePath, JSON.stringify({ ...state, effects, pendingPush: 'releasePush' }));
  const saved = JSON.stringify({ ...f.receipt, report: { ...f.receipt.report, effects } });
  await writeFile(resolve(f.slot.paths.slotRoot, 'latest-publish.json'), saved);
  expect(await runRelease({ cwd: f.cwd, command: 'recover' })).toMatchObject({ ok: true });
  git(f.cwd, 'push', 'origin', `${f.source.sha}:main`);
  const transport: ReleaseTransport = { api: async path => path.startsWith('/v9/projects') ? { id: 'prj_fixture', accountId: 'team_fixture', link: { type: 'github', org: 'fixture', repo: 'repository', repoId: 101, productionBranch: 'main', gitCredentialId: 'fixture', deployHooks: [] } } : { deployments: [] }, buildInfo: async () => ({}) };
  const status = await runRelease({ cwd: f.cwd, command: 'status', transport });
  expect(status).toMatchObject({ ok: false, effects: { releasePush: 'unknown' }, error: { code: 'DEPLOYMENT_MISSING' }, recovery: { observation: { releaseRef: { relation: 'candidate', sha: f.source.sha } } } });
  expect(await readFile(resolve(f.slot.paths.slotRoot, 'latest-publish.json'), 'utf8')).toBe(saved);
});
it('refuses switching a managed repository to workspace mode while its anchor exists', async () => {
  const f = await fixture();
  await writeFile(resolve(f.cwd, 'release.config.json'), JSON.stringify({ ...f.config, source: { mode: 'workspace' } })); f.commit();
  const before = await readFile(f.slot.paths.anchorPath);
  expect(await runRelease({ cwd: f.cwd, command: 'check' })).toMatchObject({ ok: false, error: { code: 'SOURCE_UNSUPPORTED', details: { reason: 'MANAGED_ANCHOR_EXISTS' } } });
  expect(await readFile(f.slot.paths.anchorPath)).toEqual(before);
});

it('releases a stopped local run without Vercel login and preserves its unresolved push across a later check', async () => {
  const f = await fixture();
  const original = JSON.parse(await readFile(f.slot.paths.statePath, 'utf8')) as ManagedState;
  const pending = { ...original, effects: { ...original.effects, developmentPush: 'unknown' }, pendingPush: 'developmentPush' };
  const bytes = `${JSON.stringify(pending)}\n`; await writeFile(f.slot.paths.statePath, bytes);
  const transport: ReleaseTransport = { api: async () => { throw new Error('local recovery must not require login'); }, buildInfo: async () => { throw new Error('no acceptance'); } };
  const report = await runRelease({ cwd: f.cwd, command: 'recover', transport });
  expect(report, JSON.stringify(report.error)).toMatchObject({ ok: true, effects: { developmentPush: 'unknown' }, processes: { status: 'closed' } });
  expect(await readFile(f.slot.paths.statePath, 'utf8')).toBe(bytes);
  const archive = JSON.parse(await readFile(resolve(f.slot.paths.slotRoot, 'history', `${original.runId}.json`), 'utf8'));
  expect(archive.snapshot.state).toBe(bytes);
  const slot = await openManagedSlot(f.source, f.execution);
  await slot.store.writeState({ ...original, runId: slot.runId, command: 'check' }); await slot.lock.release();
  expect(JSON.parse(await readFile(resolve(f.slot.paths.slotRoot, 'history', `${original.runId}.json`), 'utf8')).snapshot.state).toBe(bytes);
  await expect(assertManagedRemoteSettled(f.slot.paths, f.execution)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED', details: { reason: 'REMOTE_EFFECT_UNRESOLVED', effect: 'developmentPush', relation: 'before' } });
  expect(f.ref('dev')).toBe(f.initial); expect(f.ref('main')).toBe(f.initial);
  git(f.cwd, 'push', 'origin', `${f.source.sha}:dev`);
  await expect(assertManagedRemoteSettled(f.slot.paths, f.execution)).resolves.toBeUndefined();
  await writeFile(resolve(f.cwd, 'source.txt'), 'successor'); const successor = f.commit(); git(f.cwd, 'push', 'origin', 'HEAD:dev');
  await expect(assertManagedRemoteSettled(f.slot.paths, f.execution)).resolves.toBeUndefined();
  expect(f.ref('dev')).toBe(successor); expect(f.ref('main')).toBe(f.initial);
});
