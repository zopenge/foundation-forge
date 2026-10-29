import { lstat, mkdir, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { freezeManagedSource } from '../src/node/source.js';
import { openManagedSlot } from '../src/node/managed-paths.js';
import { git, managedFixture } from './helpers/managed-fixture.js';
import type { ManagedSlot } from '../src/node/release-context.js';

const fixtures: Awaited<ReturnType<typeof managedFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.dispose(); });
const fixture = async () => { const f = await managedFixture(); fixtures.push(f); return f; };
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
