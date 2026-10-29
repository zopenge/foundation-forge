import * as filesystem from 'node:fs/promises';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { managedSessionFixture } from './helpers/managed-session-fixture.js';
import { runManagedRetirement } from '../src/node/managed-retirement.js';
import { readRetirementHost, type RetirementHost } from '../src/node/retirement-host.js';
import { runRelease } from '../src/node.js';
import * as sourceBoundary from '../src/node/source.js';
import * as gitBoundary from '../src/node/git.js';
import { Execution } from '../src/node/execution.js';
import { createManagedSession } from '../src/node/managed-process.js';
import { openManagedSlot } from '../src/node/managed-paths.js';
import type { ReleaseTransport } from '../src/contracts.js';
import { currentCoordinator } from '../src/node/process-identities.js';
import { ReleaseError } from '../src/node/errors.js';

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof filesystem>() }));
vi.mock('../src/node/source.js', async importOriginal => ({ ...await importOriginal<typeof sourceBoundary>() }));
vi.mock('../src/node/git.js', async importOriginal => ({ ...await importOriginal<typeof gitBoundary>() }));

const fixtures: Awaited<ReturnType<typeof managedSessionFixture>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) await f.dispose(); });
const transport: ReleaseTransport = { api: async path => {
  if (path.startsWith('/v9/projects')) return { id: 'prj_fixture', accountId: 'team_fixture', link: { type: 'github', org: 'fixture', repo: 'repository', repoId: 101, productionBranch: 'main', gitCredentialId: 'fixture', deployHooks: [] } };
  if (path.startsWith('/v6/deployments')) return { deployments: [] };
  throw new Error('unexpected API');
}, buildInfo: async () => { throw new Error('retirement must not run acceptance'); } };
const fixture = async ({ maxBytes = 2 ** 31 } = {}) => {
  const f = await managedSessionFixture(); fixtures.push(f);
  Object.assign(f.config.source, { maxBytes });
  const bytes = Buffer.from(JSON.stringify(f.config));
  Object.assign(f.source, { configSha256: createHash('sha256').update(bytes).digest('hex'),
    configBlobOid: createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex') });
  await writeFile(resolve(f.cwd, 'release.config.json'), bytes);
  await filesystem.mkdir(f.slot.paths.checkoutRoot, { recursive: true });
  const session = await createManagedSession(f.slot, 'publish'), state = session.state;
  // 当前协议的未决意图，不启动命令、不伪造 identity/scope/closure/terminal。
  state.processes.push({ id: randomUUID(), name: 'fixture-interrupted-command', status: 'intent', descendants: [], observationComplete: false });
  const current = await currentCoordinator();
  // 合成旧 startToken，仅作为 PID 实例不匹配的组件输入；仍由真实 reader 查询当前实例。
  Object.assign(state, { coordinator: { pid: current.pid, startToken: `earlier-instance:${current.startToken}` } });
  const native = await readRetirementHost();
  // 开机观测是退役函数已有的内部注入边界；不把模拟重启报告成真实 OS 停止证据。
  Object.assign(state, { host: { ...native, uptimeSeconds: 1000 } });
  await session.persist();
  const slot = f.slot.paths.slotRoot, statePath = f.slot.paths.statePath;
  const previousLock = JSON.parse(await readFile(f.slot.paths.lockPath, 'utf8'));
  await writeFile(f.slot.paths.lockPath, JSON.stringify({ ...previousLock, pid: state.coordinator.pid, identity: state.coordinator }));
  const original = await readFile(statePath, 'utf8'), lock = await readFile(f.slot.paths.lockPath, 'utf8');
  let host: RetirementHost = { ...native, uptimeSeconds: 1030 };
  const initial = '1'.repeat(40), successor = '2'.repeat(40), refs = { dev: initial, main: initial };
  const ignore = Buffer.from('.tmp/\n'), ignoreOid = createHash('sha1').update(Buffer.from(`blob ${ignore.length}\0`)).update(ignore).digest('hex');
  await writeFile(resolve(f.cwd, '.gitignore'), ignore);
  // 只替换 Git 来源/远端组件输入。状态解析、文件身份、锁、lease、PID 查询及原子写入仍真实执行。
  vi.spyOn(sourceBoundary, 'freezeManagedSource').mockResolvedValue(f.source);
  vi.spyOn(sourceBoundary, 'inspectCommitTree').mockResolvedValue(undefined);
  vi.spyOn(sourceBoundary, 'readCommittedConfig').mockResolvedValue({ config: f.config, bytes, oid: f.source.configBlobOid });
  vi.spyOn(gitBoundary, 'assertRepository').mockResolvedValue(undefined);
  vi.spyOn(gitBoundary, 'remoteRefs').mockImplementation(async () => ({ ...refs }));
  const git = vi.spyOn(Execution.prototype, 'git').mockImplementation(async args => {
    if (JSON.stringify(args) === JSON.stringify(['merge-base', '--is-ancestor', successor, f.sha])) throw new ReleaseError('GIT_FAILED', { exitCode: 1 });
    if (JSON.stringify(args) === JSON.stringify(['merge-base', '--is-ancestor', f.sha, successor])) return '';
    if (JSON.stringify(args) === JSON.stringify(['merge-base', '--is-ancestor', f.sha, initial])) throw new ReleaseError('GIT_FAILED', { exitCode: 1 });
    if (JSON.stringify(args) === JSON.stringify(['merge-base', '--is-ancestor', initial, f.sha])) return '';
    if (JSON.stringify(args) === JSON.stringify(['rev-parse', '--verify', `${f.sha}:.gitignore`])) return ignoreOid;
    if (args.length === 7 && JSON.stringify(args.slice(0, 6)) === JSON.stringify(['-c', 'core.quotepath=false', 'check-ignore', '--no-index', '-v', '--'])
      && ['.tmp/release-slot/', '.tmp/forge-vercel-release/managed.json'].includes(args[6] ?? '')) return `.gitignore:1:.tmp/\t${args[6]}`;
    throw new Error(`unexpected retirement component Git query: ${JSON.stringify(args)}`);
  });
  vi.spyOn(Execution.prototype, 'streamGit').mockImplementation(async (args, consume) => {
    const pathspec = process.platform === 'win32' ? ':(icase,literal).tmp' : ':(literal).tmp';
    if (JSON.stringify(args) === JSON.stringify(['ls-files', '--cached', '--with-tree=HEAD', '-z', '--', pathspec])) return;
    if (JSON.stringify(args) === JSON.stringify(['ls-tree', '-rz', f.sha, '--', '.tmp/release-slot'])) return;
    if (JSON.stringify(args) === JSON.stringify(['cat-file', 'blob', ignoreOid])) { consume(ignore); return; }
    throw new Error(`unexpected retirement component Git stream: ${JSON.stringify(args)}`);
  });
  const options = { command: 'retire' as const, cwd: f.cwd, runId: state.runId, transport };
  const run = () => runManagedRetirement(options, () => Promise.resolve(host));
  const reboot = () => { host = { ...host, uptimeSeconds: 10, ...(host.platform === 'linux' ? { bootId: randomUUID() } : {}) }; };
  return { ...f, slot, statePath, state, original, lock, options, run, reboot, initial, refs, git,
    advanceRemote: () => { refs.dev = successor; }, execution: new Execution(f.cwd, f.config, undefined, []),
    setHost: (value: RetirementHost) => { host = value; }, getHost: () => host };
};
it('requires a subsequent boot for the current protocol and preserves unknown history after retirement', async () => {
  const f = await fixture();
  const first = await f.run();
  expect(f.state.schemaVersion).toBe(3);
  expect(f.state.processes[0]).toMatchObject({ status: 'intent', observationComplete: false });
  expect(f.state.processes[0]?.closure).toBeUndefined();
  expect(first).toMatchObject({ ok: false, retirement: { status: 'prepared', origin: 'recorded-run-host', historicalVerification: 'unknown' }, error: { details: { reason: 'SUBSEQUENT_BOOT_REQUIRED' } } });
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
  const reused = await openManagedSlot(f.source, f.execution);
  expect(reused.slotId).toBe(f.state.slotId); await reused.lock.release();
  expect(f.refs).toEqual({ dev: f.initial, main: f.initial });
  expect(f.git.mock.calls.some(([args]) => ['push', 'fetch'].includes(args[0] ?? ''))).toBe(false);
});
it('does not allow a changed snapshot or host to replace recorded retirement evidence', async () => {
  const f = await fixture(); await f.run();
  const checkpoint = await readFile(resolve(f.slot, 'retirement.json'), 'utf8');
  f.setHost({ ...f.getHost(), hostId: 'b'.repeat(64), uptimeSeconds: 1 });
  expect(await f.run()).toMatchObject({ ok: false, error: { details: { reason: 'RETIREMENT_HOST_CHANGED' } } });
  expect(await readFile(resolve(f.slot, 'retirement.json'), 'utf8')).toBe(checkpoint);
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
  const f = await fixture(); await f.run(); f.reboot();
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
  expect(await f.run()).toMatchObject({ ok: false, error: { code: 'LOCKED' } });
  expect(await readFile(resolve(f.slot, 'recover.lock'), 'utf8')).toBe('{"foreign":true}');
  await filesystem.unlink(resolve(f.slot, 'recover.lock'));
  const owner = await currentCoordinator(), changed = { ...f.state, coordinator: owner };
  await writeFile(f.statePath, JSON.stringify(changed));
  await writeFile(resolve(f.slot, 'run.lock'), JSON.stringify({ ...JSON.parse(f.lock), pid: owner.pid, identity: owner }));
  expect(await f.run()).toMatchObject({ ok: false, error: { details: { reason: 'OWNER_NOT_INACTIVE' } } });
  await expect(readFile(resolve(f.slot, 'retirement.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('retires local resources after a remote successor without requiring Vercel authentication', async () => {
  const f = await fixture(); await f.run(); f.reboot(); f.advanceRemote();
  const unavailable: ReleaseTransport = { api: async () => { throw new Error('Vercel login must not gate local retirement'); }, buildInfo: async () => { throw new Error('no acceptance'); } };
  const retired = await runManagedRetirement({ ...f.options, transport: unavailable }, () => Promise.resolve(f.getHost()));
  expect(retired, JSON.stringify(retired.error)).toMatchObject({ ok: true, retirement: { status: 'retired' } });
  await expect(readFile(resolve(f.slot, 'run.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  const archive = JSON.parse(await readFile(resolve(f.slot, 'retired', `${f.state.runId}.json`), 'utf8'));
  expect(archive.final.observation.developmentRef.relation).toBe('superseded');
  expect(archive.snapshot.state).toBe(f.original);
});
it('rejects corruption of the recorded boot evidence even when the new values look plausible', async () => {
  const f = await fixture(); await f.run();
  const checkpointPath = resolve(f.slot, 'retirement.json'), checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
  checkpoint.host.uptimeSeconds += 10_000; await writeFile(checkpointPath, JSON.stringify(checkpoint)); f.reboot();
  expect(await f.run()).toMatchObject({ ok: false, error: { code: 'SLOT_STATE', details: { reason: 'RETIREMENT_CHECKSUM' } } });
  expect(await readFile(resolve(f.slot, 'run.lock'), 'utf8')).toBe(f.lock);
});
it('never releases a run if archive peak bytes exceed its frozen resource budget', async () => {
  const f = await fixture({ maxBytes: 2_097_152 }); await f.run(); f.reboot();
  await writeFile(resolve(f.slot, 'checkout/budget.bin'), Buffer.alloc(2_097_152));
  expect(await f.run()).toMatchObject({ ok: false, error: { code: 'BUDGET_EXCEEDED' } });
  expect(await readFile(resolve(f.slot, 'run.lock'), 'utf8')).toBe(f.lock);
});
it('keeps the old lock on cancellation after archiving and permits a later explicit completion', async () => {
  const f = await fixture(); await f.run(); f.reboot();
  const controller = new AbortController(), realRename = filesystem.rename;
  vi.spyOn(filesystem, 'rename').mockImplementation(async (from, to) => { await realRename(from, to); if (to === resolve(f.slot, 'retired', `${f.state.runId}.json`)) controller.abort(); });
  const cancelled = await runManagedRetirement({ ...f.options, signal: controller.signal }, () => Promise.resolve(f.getHost()));
  expect(cancelled).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
  expect(await readFile(resolve(f.slot, 'run.lock'), 'utf8')).toBe(f.lock);
  expect(await f.run()).toMatchObject({ ok: true, retirement: { status: 'retired' } });
});
it('resumes its own atomic coordination claim after a real coordinator crash', async () => {
  const f = await fixture(); await f.run();
  const child = spawn(process.execPath, [resolve(import.meta.dirname, 'helpers/retirement-claim-worker.mjs')], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr?.on('data', chunk => { stderr += String(chunk); }); const closed = once(child, 'close');
  try {
    const ready = once(child, 'message'); child.send({ cwd: f.cwd });
    expect(await Promise.race([ready.then(([message]) => message), closed.then(() => ({ error: stderr }))])).toEqual({ ready: true });
    expect(child.kill('SIGKILL')).toBe(true); await closed; expect(child.signalCode).toBe('SIGKILL');
    expect(await f.run()).toMatchObject({ ok: false, retirement: { status: 'prepared' } });
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
  const prepared = await f.run();
  expect(prepared, JSON.stringify(prepared.error)).toMatchObject({ ok: false, retirement: { status: 'prepared' }, error: { details: { reason: 'SUBSEQUENT_BOOT_REQUIRED' } } });
  f.reboot();
  expect(await f.run()).toMatchObject({ ok: true, retirement: { status: 'retired' }, processes: { status: 'unknown' } });
  expect(await f.run()).toMatchObject({ ok: true, retirement: { status: 'retired' } });
  expect(await readFile(f.statePath, 'utf8')).toBe(original);
});
it('never claims a missing checkpoint was prepared when its atomic rename fails', async () => {
  const f = await fixture(), realRename = filesystem.rename;
  vi.spyOn(filesystem, 'rename').mockImplementation(async (from, to) => {
    if (to === resolve(f.slot, 'retirement.json')) throw Object.assign(new Error('fixture checkpoint rename failed'), { code: 'EACCES' });
    await realRename(from, to);
  });
  const failed = await f.run();
  expect(failed).toMatchObject({ ok: false, recovery: { reportExists: false } });
  expect(failed.retirement?.status).not.toBe('prepared');
  await expect(readFile(resolve(f.slot, 'retirement.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(resolve(f.slot, 'run.lock'), 'utf8')).toBe(f.lock);
});
