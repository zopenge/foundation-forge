import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { claimManagedRecovery } from '../src/node/managed-recovery-lock.js';
import { createManagedSession } from '../src/node/managed-process.js';
import { managedSessionFixture as managedFixture } from './helpers/managed-session-fixture.js';
import { git } from './helpers/managed-fixture.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';

const fixtures: Awaited<ReturnType<typeof managedFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.dispose(); });
const fixture = async () => {
  const f = await managedFixture(); fixtures.push(f);
  // 父侧和真实child的索引守卫都查询自有空HEAD，禁止向上发现宿主仓库。
  // state.source的SHA仍是组件输入；这里不声称冻结来源或准备完整发布仓库。
  const emptyGitDefaults = resolve(f.root, 'git-defaults'); await mkdir(emptyGitDefaults);
  git(f.cwd, 'init', `--template=${emptyGitDefaults}`, '-b', 'dev');
  git(f.cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
    '-c', `core.hooksPath=${emptyGitDefaults}`, 'commit', '--allow-empty', '-m', 'protocol index');
  expect(resolve(git(f.cwd, 'rev-parse', '--show-toplevel'))).toBe(f.cwd);
  // 锁协议使用真实路径、原始锁与当前schema3；来源准入由state/恢复集成及tarball验证。
  const slot = f.slot;
  const session = await createManagedSession(slot, 'check'); return { ...f, slot, session };
};
it('uses an independent recovery claim so two recovery callers cannot release one run', async () => {
  const f = await fixture(), recovery = await claimManagedRecovery(f.slot.paths, f.session.state);
  await expect(claimManagedRecovery(f.slot.paths, f.session.state)).rejects.toMatchObject({ code: 'LOCKED' });
  await recovery.oldLock?.assertOwned(); await recovery.claim.release(); await f.slot.lock.release();
});
it('does not remove a replaced run lock during explicit recovery', async () => {
  const f = await fixture(), recovery = await claimManagedRecovery(f.slot.paths, f.session.state);
  await writeFile(f.slot.paths.lockPath, 'different owner');
  await expect(recovery.oldLock?.release()).rejects.toMatchObject({ code: 'LOCK_OWNERSHIP' });
  expect(await readFile(f.slot.paths.lockPath, 'utf8')).toBe('different owner'); await recovery.claim.release();
});
it('resumes its own recovery metadata claim after a real recovery coordinator crash', async () => {
  const f = await fixture(), source = f.slot.source;
  await f.slot.store.writeAnchor({ schemaVersion: 2, slotId: f.slot.slotId, slotPath: f.slot.paths.slotRoot, sourceRoot: source.root, configPath: source.configPath });
  const before = await readFile(f.slot.paths.statePath);
  const child = spawn(process.execPath, [resolve(import.meta.dirname, 'helpers/retirement-claim-worker.mjs')], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr?.on('data', chunk => { stderr += String(chunk); }); const closed = once(child, 'close');
  try {
    const ready = once(child, 'message'); child.send({ cwd: f.cwd, mode: 'recover' });
    expect(await Promise.race([ready.then(([value]) => value), closed.then(() => ({ error: stderr }))])).toEqual({ ready: true });
    expect(child.kill('SIGKILL')).toBe(true); await closed;
    const recovered = await claimManagedRecovery(f.slot.paths, f.session.state);
    await recovered.oldLock?.assertOwned(); await recovered.claim.release();
    expect(await readFile(f.slot.paths.statePath)).toEqual(before);
    await f.slot.lock.release();
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; }
});
