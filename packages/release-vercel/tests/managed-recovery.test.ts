import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { classifyRemoteRef, inspectManagedRecovery, runManagedReceiptCommand, selectManagedPublication } from '../src/node/managed-recovery.js';
import { freezeManagedSource } from '../src/node/source.js';
import { openManagedSlot } from '../src/node/managed-paths.js';
import { git, managedFixture } from './helpers/managed-fixture.js';
import type { ManagedReceipt, ManagedState } from '../src/node/release-context.js';
import type { ReleaseTransport } from '../src/contracts.js';
import { runRelease } from '../src/node.js';

const fixtures: Awaited<ReturnType<typeof managedFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.dispose(); });
const fixture = async () => {
  const f = await managedFixture(); fixtures.push(f);
  const declared = 'https://github.com/fixture/repository.git';
  git(f.cwd, 'config', `url.${f.remote.replaceAll('\\', '/')}.insteadOf`, declared);
  git(f.cwd, 'remote', 'set-url', 'origin', declared); Object.assign(f.config.git, { repository: 'github.com/fixture/repository' });
  await writeFile(resolve(f.cwd, 'release.config.json'), JSON.stringify(f.config)); f.commit();
  const source = await freezeManagedSource(f.cwd, 'release.config.json', f.execution), slot = await openManagedSlot(source, f.execution);
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
  expect(await classifyRemoteRef(f.execution, f.source.sha, later)).toBe('after');
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
it('recovers an already closed run without any installation or Git push', async () => {
  const f = await fixture();
  const transport: ReleaseTransport = { api: async path => path.startsWith('/v9/projects') ? { id: 'prj_fixture', accountId: 'team_fixture', link: { type: 'github', org: 'fixture', repo: 'repository', repoId: 101, productionBranch: 'main', gitCredentialId: 'fixture', deployHooks: [] } } : { deployments: [] },
    buildInfo: async () => { throw new Error('recover must not run acceptance'); } };
  const report = await runRelease({ cwd: f.cwd, command: 'recover', transport });
  expect(report, JSON.stringify(report.error)).toMatchObject({ ok: true, command: 'recover', candidateSha: f.source.sha, processes: { status: 'closed' } });
  expect(f.ref('dev')).toBe(f.initial); expect(f.ref('main')).toBe(f.initial);
  expect(report.steps.some(step => step.name === 'install' || step.name.startsWith('check:'))).toBe(false);
});
it('routes public status through the frozen receipt even when current config no longer validates', async () => {
  const f = await fixture(); await writeFile(resolve(f.cwd, 'release.config.json'), '{"later":true}'); f.commit();
  const transport: ReleaseTransport = { api: async path => path.startsWith('/v9/projects') ? { id: 'prj_fixture', accountId: 'team_fixture', link: { type: 'github', org: 'fixture', repo: 'repository', repoId: 101, productionBranch: 'main', gitCredentialId: 'fixture', deployHooks: [] } } : { deployments: [] }, buildInfo: async () => ({}) };
  expect(await runRelease({ cwd: f.cwd, command: 'status', transport })).toMatchObject({ candidateSha: f.source.sha, error: { code: 'DEPLOYMENT_MISSING' } });
});
it.each([true, false])('reports reconciled facts only with durable recovery evidence: %s', async recovered => {
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
  expect(status).toMatchObject({ ok: false, effects: { releasePush: recovered ? 'not-current' : 'unknown' },
    error: { code: recovered ? 'DEPLOYMENT_MISSING' : 'RECOVERY_REQUIRED' } });
  expect(status.recovery?.observation?.releaseRef).toEqual({ sha: f.initial, relation: 'before' });
  expect(await readFile(resolve(f.slot.paths.slotRoot, 'latest-publish.json'), 'utf8')).toBe(saved);
});
it('refuses switching a managed repository to workspace mode while its anchor exists', async () => {
  const f = await fixture();
  await writeFile(resolve(f.cwd, 'release.config.json'), JSON.stringify({ ...f.config, source: { mode: 'workspace' } })); f.commit();
  const before = await readFile(f.slot.paths.anchorPath);
  expect(await runRelease({ cwd: f.cwd, command: 'check' })).toMatchObject({ ok: false, error: { code: 'SOURCE_UNSUPPORTED', details: { reason: 'MANAGED_ANCHOR_EXISTS' } } });
  expect(await readFile(f.slot.paths.anchorPath)).toEqual(before);
});
