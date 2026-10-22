import { lstat, mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { freezeManagedSource } from '../src/node/source.js';
import { openManagedSlot, assertManagedPaths } from '../src/node/managed-paths.js';
import { git, managedFixture } from './helpers/managed-fixture.js';
import type { ManagedReceipt } from '../src/node/release-context.js';
import type { ManagedSlot } from '../src/node/release-context.js';
import { fileIdentity } from '../src/node/managed-io.js';

const fixtures: Awaited<ReturnType<typeof managedFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.dispose(); });
const fixture = async () => { const f = await managedFixture(); fixtures.push(f); return f; };
it('preserves exact filesystem identifiers without JavaScript number rounding', async () => {
  const f = await fixture(), actual = await lstat(f.cwd, { bigint: true });
  expect(await fileIdentity(f.cwd)).toEqual({ dev: actual.dev.toString(), ino: actual.ino.toString() });
});
it('owns one fixed slot and holds an exclusive full-lifecycle lock', async () => {
  const f = await fixture(), source = await freezeManagedSource(f.cwd, 'release.config.json', f.execution);
  const first = await openManagedSlot(source, f.execution);
  await expect(openManagedSlot(source, f.execution)).rejects.toMatchObject({ code: 'LOCKED' });
  await first.lock.release();
  const second = await openManagedSlot(source, f.execution);
  expect(second.slotId).toBe(first.slotId); expect(second.paths.slotRoot).toBe(first.paths.slotRoot);
  await second.lock.release();
});
it.each(['foreign', 'unignored', 'junction', 'corrupt'])('refuses %s slot without changing it', async mode => {
  const f = await fixture(), path = resolve(f.cwd, '.tmp/release-slot');
  if (mode === 'unignored') { await writeFile(resolve(f.cwd, '.gitignore'), 'node_modules/\n'); f.commit(); }
  if (mode === 'foreign') await mkdir(path, { recursive: true });
  if (mode === 'junction') { await mkdir(resolve(f.cwd, '.tmp'), { recursive: true }); await symlink(f.root, path, 'junction'); }
  if (mode === 'corrupt') { await mkdir(path, { recursive: true }); await writeFile(resolve(path, 'ownership.json'), '{}'); }
  const source = await freezeManagedSource(f.cwd, 'release.config.json', f.execution);
  await expect(openManagedSlot(source, f.execution)).rejects.toMatchObject({ code: mode === 'unignored' || mode === 'junction' ? 'SLOT_PATH' : 'SLOT_FOREIGN' });
});
it('detects replaced locks and does not release the replacement', async () => {
  const f = await fixture(), source = await freezeManagedSource(f.cwd, 'release.config.json', f.execution);
  const slot = await openManagedSlot(source, f.execution);
  await writeFile(slot.paths.lockPath, 'new owner');
  await expect(slot.lock.assertOwned()).rejects.toMatchObject({ code: 'LOCK_OWNERSHIP' });
  await expect(slot.lock.release()).rejects.toMatchObject({ code: 'LOCK_OWNERSHIP' });
  expect(await readFile(slot.paths.lockPath, 'utf8')).toBe('new owner');
});
it('keeps check and publish receipts separate and bounds UTF-8 output', async () => {
  const f = await fixture(), source = await freezeManagedSource(f.cwd, 'release.config.json', f.execution);
  const slot = await openManagedSlot(source, f.execution);
  const receipt: ManagedReceipt = { schemaVersion: 2, slotId: slot.slotId, source,
    report: { schemaVersion: 2, command: 'publish', ok: true, candidateSha: source.sha, configSha256: source.configSha256,
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), steps: [{ name: 'check', ok: true, durationMs: 1, stdout: '中文'.repeat(2000) }],
      effects: { developmentPush: 'pushed', releasePush: 'unknown' } } };
  await slot.store.writeReceipt('publish', receipt);
  await slot.store.writeReceipt('check', { ...receipt, report: { ...receipt.report, command: 'check' } });
  const saved = await slot.store.readReceipt('publish');
  expect(saved?.report.command).toBe('publish'); expect(saved?.report.effects.releasePush).toBe('unknown');
  const step = saved?.report.steps[0]; expect(Buffer.byteLength(step?.stdout ?? '')).toBeLessThanOrEqual(2048);
  expect(step?.stdout).not.toContain('\ufffd'); expect(step?.truncated).toBe(true);
  await expect(slot.store.writeReceipt('check', { ...receipt, report: { ...receipt.report, error: { code: 'IO_FAILED', details: { value: 'x'.repeat(1_048_576) } } } })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
  await slot.lock.release();
});
it('rejects external Git metadata and incomplete JSON state', async () => {
  const f = await fixture(), source = await freezeManagedSource(f.cwd, 'release.config.json', f.execution);
  const slot = await openManagedSlot(source, f.execution);
  git(f.root, 'init', slot.paths.checkoutRoot);
  await writeFile(resolve(slot.paths.checkoutRoot, '.git/commondir'), f.cwd);
  await expect(assertManagedPaths(slot.paths)).rejects.toMatchObject({ code: 'SLOT_PATH' });
  await unlink(resolve(slot.paths.checkoutRoot, '.git/commondir'));
  await writeFile(slot.paths.statePath, '{"schemaVersion":');
  await expect(slot.store.read()).rejects.toMatchObject({ code: 'SLOT_STATE' });
});
it('rejects a mismatched anchor and the anchor size limit', async () => {
  const f = await fixture(), source = await freezeManagedSource(f.cwd, 'release.config.json', f.execution);
  const slot = await openManagedSlot(source, f.execution);
  const anchor = { schemaVersion: 2 as const, slotId: slot.slotId, slotPath: slot.paths.slotRoot, configPath: source.configPath, sourceRoot: source.root };
  await expect(slot.store.writeAnchor({ ...anchor, slotId: 'foreign' })).rejects.toMatchObject({ code: 'SLOT_STATE' });
  await expect(slot.store.writeAnchor({ ...anchor, slotPath: 'x'.repeat(65_536) })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
  await slot.lock.release();
});
it('protects management files newly tracked in the source index', async () => {
  const f = await fixture(), source = await freezeManagedSource(f.cwd, 'release.config.json', f.execution);
  const slot = await openManagedSlot(source, f.execution); await slot.lock.release();
  git(f.cwd, 'add', '--force', '.tmp/release-slot/ownership.json');
  let opened: ManagedSlot | undefined;
  try {
    const result = await openManagedSlot(source, f.execution).then(value => { opened = value; return { opened: true }; }, (error: unknown) => ({ error }));
    expect(result).toMatchObject({ error: { code: 'SLOT_PATH' } });
    expect(git(f.cwd, 'diff', '--cached', '--name-only')).toBe('.tmp/release-slot/ownership.json');
  } finally { await opened?.lock.release(); }
});
it('rejects a changed slot binding before creating a second slot', async () => {
  const f = await fixture(), source = await freezeManagedSource(f.cwd, 'release.config.json', f.execution);
  const slot = await openManagedSlot(source, f.execution);
  await slot.store.writeAnchor({ schemaVersion: 2, slotId: slot.slotId, slotPath: slot.paths.slotRoot, sourceRoot: source.root, configPath: source.configPath });
  await slot.lock.release();
  if (f.config.source.mode !== 'managed-commit') throw new Error('fixture mode');
  Object.assign(f.config.source, { slotPath: '.tmp/second-slot' }); await writeFile(resolve(f.cwd, 'release.config.json'), JSON.stringify(f.config)); f.commit();
  const changed = await freezeManagedSource(f.cwd, 'release.config.json', f.execution);
  await expect(openManagedSlot(changed, f.execution)).rejects.toMatchObject({ code: 'SLOT_STATE', details: { reason: 'MANAGEMENT_REBINDING' } });
  await expect(lstat(resolve(f.cwd, '.tmp/second-slot'))).rejects.toMatchObject({ code: 'ENOENT' });
});
