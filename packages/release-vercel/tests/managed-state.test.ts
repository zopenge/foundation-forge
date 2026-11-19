import { lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireLocalDirectoryLease } from '@openge/forge-process-control-node';
import { afterEach, expect, it } from 'vitest';
import { freezeManagedSource } from '../src/node/source.js';
import { openManagedSlot } from '../src/node/managed-paths.js';
import { git, managedFixture } from './helpers/managed-fixture.js';
import type { ManagedSlot } from '../src/node/managed-slot-contracts.js';
import { createManagedSession } from '../src/node/managed-process.js';
import { createManagedExecution } from '../src/node/managed-execution.js';
import { runRelease } from '../src/node.js';

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
it('recovers a returned SDK invocation and opens the next run in the same Node process', async () => {
  const f = await fixture(), source = await freezeManagedSource(f.cwd, 'release.config.json', f.execution);
  const first = await openManagedSlot(source, f.execution, 'check');
  try {
    const session = await createManagedSession(first, 'check');
    await first.store.writeAnchor({ schemaVersion: 2, slotId: first.slotId, slotPath: first.paths.slotRoot, sourceRoot: source.root, configPath: source.configPath });
    session.state.status = 'unknown';
    await session.persist();
    const options = { command: 'recover' as const, cwd: f.cwd };
    expect(await runRelease(options)).toMatchObject({ ok: false, error: { code: 'LOCKED' } });
    await first.coordinatorLease?.release();
    expect(await runRelease(options)).toMatchObject({ ok: true, runId: first.runId, processes: { status: 'closed' } });
    const next = await openManagedSlot(source, f.execution, 'check');
    try {
      expect(next.runId).not.toBe(first.runId);
      expect(next.coordinator).toEqual(first.coordinator);
    } finally {
      try { await next.lock.release(); } finally { await next.coordinatorLease?.release(); }
    }
  } finally {
    await first.coordinatorLease?.release();
  }
});
it.each(['foreign', 'unignored', 'junction', 'corrupt'])('refuses %s slot without changing it', async mode => {
  const f = await fixture(), path = resolve(f.cwd, 'state/release-slot');
  if (mode === 'unignored') { await writeFile(resolve(f.cwd, '.gitignore'), 'node_modules/\n'); f.commit(); }
  if (mode === 'foreign') await mkdir(path, { recursive: true });
  if (mode === 'junction') { await mkdir(dirname(path), { recursive: true }); await symlink(f.root, path, 'junction'); }
  if (mode === 'corrupt') { await mkdir(path, { recursive: true }); await writeFile(resolve(path, 'ownership.json'), '{}'); }
  const source = await freezeManagedSource(f.cwd, 'release.config.json', f.execution);
  await expect(openManagedSlot(source, f.execution)).rejects.toMatchObject({ code: mode === 'unignored' || mode === 'junction' ? 'SLOT_PATH' : 'SLOT_FOREIGN' });
});
it('protects management files newly tracked in the source index', async () => {
  const f = await fixture(), source = await freezeManagedSource(f.cwd, 'release.config.json', f.execution);
  const slot = await openManagedSlot(source, f.execution); await slot.lock.release();
  git(f.cwd, 'add', '--force', 'state/release-slot/ownership.json');
  let opened: ManagedSlot | undefined;
  try {
    const result = await openManagedSlot(source, f.execution).then(value => { opened = value; return { opened: true }; }, (error: unknown) => ({ error }));
    expect(result).toMatchObject({ error: { code: 'SLOT_PATH' } });
    expect(git(f.cwd, 'diff', '--cached', '--name-only')).toBe('state/release-slot/ownership.json');
  } finally { await opened?.lock.release(); }
});
it('rejects a changed slot binding before creating a second slot', async () => {
  const f = await fixture(), source = await freezeManagedSource(f.cwd, 'release.config.json', f.execution);
  const slot = await openManagedSlot(source, f.execution);
  await slot.store.writeAnchor({ schemaVersion: 2, slotId: slot.slotId, slotPath: slot.paths.slotRoot, sourceRoot: source.root, configPath: source.configPath });
  await slot.lock.release();
  if (f.config.source.mode !== 'managed-commit') throw new Error('fixture mode');
  Object.assign(f.config.source, { slotPath: 'tmp/second-slot' }); await writeFile(resolve(f.cwd, 'release.config.json'), JSON.stringify(f.config)); f.commit();
  const changed = await freezeManagedSource(f.cwd, 'release.config.json', f.execution);
  await expect(openManagedSlot(changed, f.execution)).rejects.toMatchObject({ code: 'SLOT_STATE', details: { reason: 'MANAGEMENT_REBINDING' } });
  await expect(lstat(resolve(f.cwd, 'tmp/second-slot'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('admits a committed replacement slot in a fresh source root without mutating the original run', async () => {
  const f = await fixture(), source = await freezeManagedSource(f.cwd, 'release.config.json', f.execution);
  const prior = await openManagedSlot(source, f.execution), old = await createManagedSession(prior, 'check');
  await prior.store.writeAnchor({ schemaVersion: 2, slotId: prior.slotId, slotPath: prior.paths.slotRoot, sourceRoot: source.root, configPath: source.configPath });
  old.state.status = 'unknown';
  old.state.processes.push({ id: randomUUID(), name: 'git-stream', status: 'intent', descendants: [], observationComplete: false });
  await old.persist();
  await mkdir(prior.paths.checkoutRoot);
  const payload = resolve(prior.paths.checkoutRoot, 'original.txt');
  await writeFile(payload, 'preserved old checkout');
  const originalPaths = [prior.paths.statePath, prior.paths.lockPath, prior.paths.anchorPath, payload];
  const before = await Promise.all(originalPaths.map(path => readFile(path, 'utf8')));
  if (f.config.source.mode !== 'managed-commit') throw new Error('fixture mode');
  const config = { ...f.config, source: { ...f.config.source, slotPath: 'state/replacement-slot', observationTimeoutMs: 60_000 } };
  const fresh = resolve(f.root, 'replacement-source');
  git(f.root, 'clone', '--no-hardlinks', '--branch', 'dev', f.cwd, fresh);
  git(fresh, 'remote', 'set-url', 'origin', f.remote);
  await writeFile(resolve(fresh, 'release.config.json'), JSON.stringify(config));
  git(fresh, 'add', '--', 'release.config.json');
  git(fresh, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'select replacement slot');
  const sha = git(fresh, 'rev-parse', 'HEAD');
  const execution = createManagedExecution(fresh, config, undefined, []);
  const frozen = await freezeManagedSource(fresh, 'release.config.json', execution);
  const writer = await acquireLocalDirectoryLease(f.root, { scope: { namespace: 'FoundationForge.Test.Release', discriminator: 'fixture-project' } });
  try {
    const successor = await openManagedSlot(frozen, execution);
    try {
      expect(frozen.sha).toBe(sha);
      expect(successor.slotId).not.toBe(prior.slotId);
      expect(successor.paths.slotRoot).toBe(resolve(fresh, 'state/replacement-slot'));
      expect(await Promise.all(originalPaths.map(path => readFile(path, 'utf8')))).toEqual(before);
    } finally { await successor.lock.release(); }
  } finally { await writer.release(); }
});
