import * as filesystem from 'node:fs/promises';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { git, managedFixture } from './helpers/managed-fixture.js';
import { runManagedRetirement } from '../src/node/managed-retirement.js';
import { readRetirementHost, type RetirementHost } from '../src/node/retirement-host.js';
import { runRelease } from '../src/node.js';
import { freezeManagedSource } from '../src/node/source.js';
import { openManagedSlot } from '../src/node/managed-paths.js';
import type { ManagedState } from '../src/node/release-context.js';
import type { ReleaseTransport } from '../src/contracts.js';
import { currentCoordinator } from '../src/node/process-identities.js';

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof filesystem>() }));

const fixtures: Awaited<ReturnType<typeof managedFixture>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) await f.dispose(); });
const transport: ReleaseTransport = { api: async path => {
  if (path.startsWith('/v9/projects')) return { id: 'prj_fixture', accountId: 'team_fixture', link: { type: 'github', org: 'fixture', repo: 'repository', repoId: 101, productionBranch: 'main', gitCredentialId: 'fixture', deployHooks: [] } };
  if (path.startsWith('/v6/deployments')) return { deployments: [] };
  throw new Error('unexpected API');
}, buildInfo: async () => { throw new Error('retirement must not run acceptance'); } };
const fixture = async ({ legacy = true, maxBytes = 2 ** 31 } = {}) => {
  const f = await managedFixture(); fixtures.push(f);
  const declared = 'https://github.com/fixture/repository.git';
  git(f.cwd, 'config', `url.${f.remote.replaceAll('\\', '/')}.insteadOf`, declared);
  git(f.cwd, 'remote', 'set-url', 'origin', declared); Object.assign(f.config.git, { repository: 'github.com/fixture/repository' });
  Object.assign(f.config.source, { maxBytes });
  await writeFile(resolve(f.cwd, 'release.config.json'), JSON.stringify(f.config)); f.commit();
  await promisify(execFile)(process.execPath, [resolve(import.meta.dirname, 'helpers/closed-managed-worker.mjs'), f.cwd], { windowsHide: true, timeout: 120_000 });
  const slot = resolve(f.cwd, '.tmp/release-slot'), statePath = resolve(slot, 'state.json');
  const state: ManagedState = JSON.parse(await readFile(statePath, 'utf8')) as ManagedState;
  const command = state.processes[0]; if (!command) throw new Error('missing real fixture command');
  command.status = 'identified'; command.observationComplete = false; delete command.closure;
  delete command.terminalSha256;
  // 明确模拟没有独立终态协议的旧运行，不能保留新协议的恢复证明。
  Reflect.set(state, 'schemaVersion', 2);
  try { await filesystem.unlink(resolve(slot, 'terminal.json')); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  // 模拟旧格式缺少宿主来源以及完成事件未持久化；真实子进程已经由 helper 正常收尾。
  if (legacy) Reflect.deleteProperty(state, 'host');
  await writeFile(statePath, `${JSON.stringify(state)}\n`);
  const original = await readFile(statePath, 'utf8'), lock = await readFile(resolve(slot, 'run.lock'), 'utf8');
  const native = await readRetirementHost();
  let host: RetirementHost = { ...native, uptimeSeconds: state.host ? state.host.uptimeSeconds + 30 : 1000 };
  const options = { command: 'retire' as const, cwd: f.cwd, runId: state.runId, transport };
  const run = (confirmOrigin?: string) => runManagedRetirement({ ...options, ...(confirmOrigin ? { confirmOrigin } : {}) }, () => Promise.resolve(host));
  const reboot = () => { host = { ...host, uptimeSeconds: 10, ...(host.platform === 'linux' ? { bootId: '10000000-0000-4000-8000-000000000002' } : {}) }; };
  return { ...f, slot, statePath, state, original, lock, options, run, reboot, setHost: (value: RetirementHost) => { host = value; }, getHost: () => host };
};
it('requires a snapshot-bound legacy origin assertion and an independently observed subsequent boot', async () => {
  const f = await fixture();
  const first = await f.run();
  expect(first).toMatchObject({ ok: false, error: { code: 'RECOVERY_REQUIRED', details: { reason: 'ORIGIN_CONFIRMATION_REQUIRED' } }, retirement: { status: 'confirmation-required', historicalVerification: 'unknown' } });
  const confirmation = first.retirement?.originConfirmation;
  expect(confirmation).toMatch(/^[a-f0-9]{64}$/u);
  expect(await f.run('f'.repeat(64))).toMatchObject({ ok: false, error: { details: { reason: 'ORIGIN_CONFIRMATION_MISMATCH' } } });
  const prepared = await f.run(confirmation);
  expect(prepared).toMatchObject({ ok: false, retirement: { status: 'prepared', origin: 'operator-confirmed-origin' }, error: { details: { reason: 'SUBSEQUENT_BOOT_REQUIRED' } } });
  expect(await f.run()).toMatchObject({ ok: false, error: { details: { reason: 'SUBSEQUENT_BOOT_REQUIRED' } } });
  expect(await readFile(f.statePath, 'utf8')).toBe(f.original);
  expect(await readFile(resolve(f.slot, 'run.lock'), 'utf8')).toBe(f.lock);
  f.reboot(); const retired = await f.run();
  expect(retired, JSON.stringify(retired.error)).toMatchObject({ ok: true, command: 'retire', processes: { status: 'unknown' }, retirement: { status: 'retired', historicalVerification: 'unknown', cessation: 'observed-subsequent-boot' }, effects: { developmentPush: 'not-attempted', releasePush: 'not-attempted' } });
  expect(await readFile(f.statePath, 'utf8')).toBe(f.original);
  await expect(readFile(resolve(f.slot, 'run.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  const archive = JSON.parse(await readFile(retired.retirement?.archivePath ?? '', 'utf8')) as { snapshot: { state: string } };
  expect(archive.snapshot.state).toBe(f.original);
  expect(await f.run()).toMatchObject({ ok: true, retirement: { status: 'retired' } });
  const source = await freezeManagedSource(f.cwd, 'release.config.json', f.execution), reused = await openManagedSlot(source, f.execution);
  expect(reused.slotId).toBe(f.state.slotId); await reused.lock.release();
  expect(f.ref('dev')).toBe(f.initial); expect(f.ref('main')).toBe(f.initial);
});
it('does not use an origin acknowledgement to override a changed snapshot or host', async () => {
  const f = await fixture(), first = await f.run();
  await f.run(first.retirement?.originConfirmation);
  f.setHost({ ...f.getHost(), hostId: 'b'.repeat(64), uptimeSeconds: 1 });
  expect(await f.run(first.retirement?.originConfirmation)).toMatchObject({ ok: false, error: { details: { reason: 'RETIREMENT_HOST_CHANGED' } }, recovery: { reportExists: true } });
  f.setHost({ ...await readRetirementHost(), uptimeSeconds: 10 });
  await writeFile(f.statePath, `${f.original} `);
  expect(await f.run()).toMatchObject({ ok: false, error: { details: { reason: 'RETIREMENT_INPUT_CHANGED' } } });
  expect(await readFile(resolve(f.slot, 'run.lock'), 'utf8')).toBe(f.lock);
});
it('the public command requires an exact run id and normal recovery still preserves missing closure', async () => {
  const f = await fixture();
  expect(await runRelease({ ...f.options, runId: '00000000-0000-4000-8000-000000000000' })).toMatchObject({ ok: false, error: { details: { reason: 'RETIREMENT_RUN_MISMATCH' } } });
  const recovery = await runRelease({ cwd: f.cwd, command: 'recover', transport });
  expect(recovery).toMatchObject({ ok: false, error: { code: 'PROCESS_STATE_UNKNOWN' }, recovery: { reportExists: false } });
  expect(recovery.recovery?.nextCommand).toContain(`retire --run-id ${f.state.runId}`);
  const normal = await runRelease({ cwd: f.cwd, command: 'check', transport });
  expect(normal).toMatchObject({ ok: false, error: { code: 'PROCESS_STATE_UNKNOWN', details: { runId: f.state.runId, nextCommand: expect.stringContaining(`retire --run-id ${f.state.runId}`) } } });
});
it('resumes after archive persistence and after lock release without rewriting historical evidence', async () => {
  const f = await fixture(), first = await f.run(); await f.run(first.retirement?.originConfirmation); f.reboot();
  const realUnlink = filesystem.unlink;
  let failRunLock = true, failClaim = false;
  vi.spyOn(filesystem, 'unlink').mockImplementation(async path => {
    if ((failRunLock && path === resolve(f.slot, 'run.lock')) || (failClaim && path === resolve(f.slot, 'recover.lock'))) throw Object.assign(new Error('fixture write interruption'), { code: 'EACCES' });
    return realUnlink(path);
  });
  expect(await f.run()).toMatchObject({ ok: false });
  expect(await readFile(f.statePath, 'utf8')).toBe(f.original);
  expect(await readFile(resolve(f.slot, 'run.lock'), 'utf8')).toBe(f.lock);
  failRunLock = false; failClaim = true;
  expect(await f.run()).toMatchObject({ ok: false, retirement: { status: 'retired' } });
  await expect(readFile(resolve(f.slot, 'run.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  failClaim = false;
  const resumed = await f.run();
  expect(resumed, JSON.stringify(resumed.error)).toMatchObject({ ok: true, retirement: { status: 'retired' } });
  await expect(readFile(resolve(f.slot, 'recover.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(f.statePath, 'utf8')).toBe(f.original);
});
it('keeps a live original coordinator and a foreign recovery claim protected', async () => {
  const f = await fixture();
  await writeFile(resolve(f.slot, 'recover.lock'), '{"foreign":true}');
  const first = await f.run();
  expect(await f.run(first.retirement?.originConfirmation)).toMatchObject({ ok: false, error: { code: 'LOCKED' } });
  expect(await readFile(resolve(f.slot, 'recover.lock'), 'utf8')).toBe('{"foreign":true}');
  await filesystem.unlink(resolve(f.slot, 'recover.lock'));
  const owner = await currentCoordinator(), changed = { ...f.state, coordinator: owner };
  await writeFile(f.statePath, JSON.stringify(changed));
  await writeFile(resolve(f.slot, 'run.lock'), JSON.stringify({ ...JSON.parse(f.lock), pid: owner.pid, identity: owner }));
  const active = await f.run();
  expect(await f.run(active.retirement?.originConfirmation)).toMatchObject({ ok: false, error: { details: { reason: 'OWNER_NOT_INACTIVE' } } });
  await expect(readFile(resolve(f.slot, 'retirement.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('retires local resources after a remote successor without requiring Vercel authentication', async () => {
  const f = await fixture(), first = await f.run(); await f.run(first.retirement?.originConfirmation); f.reboot();
  await writeFile(resolve(f.cwd, 'source.txt'), 'later candidate\n'); f.commit(); git(f.cwd, 'push', 'origin', 'HEAD:dev');
  const unavailable: ReleaseTransport = { api: async () => { throw new Error('Vercel login must not gate local retirement'); }, buildInfo: async () => { throw new Error('no acceptance'); } };
  const retired = await runManagedRetirement({ ...f.options, transport: unavailable }, () => Promise.resolve(f.getHost()));
  expect(retired).toMatchObject({ ok: true, retirement: { status: 'retired' } });
  await expect(readFile(resolve(f.slot, 'run.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  const archive = JSON.parse(await readFile(resolve(f.slot, 'retired', `${f.state.runId}.json`), 'utf8'));
  expect(archive.final.observation.developmentRef.relation).toBe('superseded');
  expect(archive.snapshot.state).toBe(f.original);
});
it('rejects corruption of the recorded boot evidence even when the new values look plausible', async () => {
  const f = await fixture(), first = await f.run(); await f.run(first.retirement?.originConfirmation);
  const checkpointPath = resolve(f.slot, 'retirement.json'), checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
  checkpoint.host.uptimeSeconds += 10_000; await writeFile(checkpointPath, JSON.stringify(checkpoint)); f.reboot();
  expect(await f.run()).toMatchObject({ ok: false, error: { code: 'SLOT_STATE', details: { reason: 'RETIREMENT_CHECKSUM' } } });
  expect(await readFile(resolve(f.slot, 'run.lock'), 'utf8')).toBe(f.lock);
});
it('uses recorded original-host evidence without requiring a legacy assertion', async () => {
  const f = await fixture({ legacy: false });
  expect(await f.run()).toMatchObject({ ok: false, retirement: { status: 'prepared', origin: 'recorded-run-host' } });
  f.reboot(); expect(await f.run()).toMatchObject({ ok: true, retirement: { status: 'retired', origin: 'recorded-run-host' } });
});
it('never releases a run if archive peak bytes exceed its frozen resource budget', async () => {
  const f = await fixture({ maxBytes: 2_097_152 }), first = await f.run();
  await f.run(first.retirement?.originConfirmation); f.reboot();
  await writeFile(resolve(f.slot, 'checkout/budget.bin'), Buffer.alloc(2_097_152));
  expect(await f.run()).toMatchObject({ ok: false, error: { code: 'BUDGET_EXCEEDED' } });
  expect(await readFile(resolve(f.slot, 'run.lock'), 'utf8')).toBe(f.lock);
});
it('keeps the old lock on cancellation after archiving and permits a later explicit completion', async () => {
  const f = await fixture(), first = await f.run(); await f.run(first.retirement?.originConfirmation); f.reboot();
  const controller = new AbortController(), realRename = filesystem.rename;
  vi.spyOn(filesystem, 'rename').mockImplementation(async (from, to) => { await realRename(from, to); if (to === resolve(f.slot, 'retired', `${f.state.runId}.json`)) controller.abort(); });
  const cancelled = await runManagedRetirement({ ...f.options, signal: controller.signal }, () => Promise.resolve(f.getHost()));
  expect(cancelled).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
  expect(await readFile(resolve(f.slot, 'run.lock'), 'utf8')).toBe(f.lock);
  expect(await f.run()).toMatchObject({ ok: true, retirement: { status: 'retired' } });
});
it('resumes its own atomic coordination claim after a real coordinator crash', async () => {
  const f = await fixture(), first = await f.run();
  const child = spawn(process.execPath, [resolve(import.meta.dirname, 'helpers/retirement-claim-worker.mjs')], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr?.on('data', chunk => { stderr += String(chunk); }); const closed = once(child, 'close');
  try {
    const ready = once(child, 'message'); child.send({ cwd: f.cwd });
    expect(await Promise.race([ready.then(([message]) => message), closed.then(() => ({ error: stderr }))])).toEqual({ ready: true });
    expect(child.kill('SIGKILL')).toBe(true); await closed; expect(child.signalCode).toBe('SIGKILL');
    expect(await f.run(first.retirement?.originConfirmation)).toMatchObject({ ok: false, retirement: { status: 'prepared' } });
    await expect(readFile(resolve(f.slot, 'recover.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(resolve(f.slot, 'run.lock'), 'utf8')).toBe(f.lock);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; }
});
it('retirement distinguishes a different coordinator instance without upgrading missing child closure', async () => {
  const f = await fixture(), current = await currentCoordinator();
  const historical = { pid: current.pid, startToken: `earlier-instance:${current.startToken}` };
  const state = { ...f.state, coordinator: historical };
  const original = JSON.stringify(state), lock = JSON.stringify({ ...JSON.parse(f.lock), pid: historical.pid, identity: historical });
  await writeFile(f.statePath, original); await writeFile(resolve(f.slot, 'run.lock'), lock);
  const normal = await runRelease({ command: 'recover', cwd: f.cwd, transport });
  expect(normal).toMatchObject({ ok: false, processes: { status: 'unknown' }, recovery: { observation: { owner: 'inactive' } } });
  const first = await f.run(), prepared = await f.run(first.retirement?.originConfirmation);
  expect(prepared, JSON.stringify(prepared.error)).toMatchObject({ ok: false, retirement: { status: 'prepared' }, error: { details: { reason: 'SUBSEQUENT_BOOT_REQUIRED' } } });
  f.reboot();
  expect(await f.run()).toMatchObject({ ok: true, retirement: { status: 'retired' }, processes: { status: 'unknown' } });
  expect(await f.run()).toMatchObject({ ok: true, retirement: { status: 'retired' } });
  expect(await readFile(f.statePath, 'utf8')).toBe(original);
});
it('never claims a missing checkpoint was prepared when its atomic rename fails', async () => {
  const f = await fixture(), first = await f.run(), realRename = filesystem.rename;
  vi.spyOn(filesystem, 'rename').mockImplementation(async (from, to) => {
    if (to === resolve(f.slot, 'retirement.json')) throw Object.assign(new Error('fixture checkpoint rename failed'), { code: 'EACCES' });
    await realRename(from, to);
  });
  const failed = await f.run(first.retirement?.originConfirmation);
  expect(failed).toMatchObject({ ok: false, recovery: { reportExists: false } });
  expect(failed.retirement?.status).not.toBe('prepared');
  await expect(readFile(resolve(f.slot, 'retirement.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(resolve(f.slot, 'run.lock'), 'utf8')).toBe(f.lock);
});
