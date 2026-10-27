import { spawn } from 'node:child_process';
import { link, lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { BudgetMonitor, observeBudget } from '../src/node/managed-budget.js';
import { managedBudgetFixture } from './helpers/managed-budget-fixture.js';
import type { ManagedSourceConfig } from '../src/contracts.js';
import { ReleaseError } from '../src/node/errors.js';
import { measureManagedUsage } from '../src/node/managed-io.js';

const fixtures: Awaited<ReturnType<typeof managedBudgetFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.dispose(); });
const fixture = async () => {
  const f = await managedBudgetFixture(); fixtures.push(f); return f;
};
it('counts hardlink entries conservatively and includes anchor metadata', async () => {
  const f = await fixture(); const before = await observeBudget(f.paths, f.limits);
  const file = resolve(f.paths.slotRoot, 'fixture-data'); await writeFile(file, Buffer.alloc(1000));
  await link(file, resolve(f.paths.slotRoot, 'fixture-link'));
  await writeFile(f.paths.anchorPath, 'x'.repeat(77));
  const after = await observeBudget(f.paths, f.limits);
  expect(after.bytes - before.bytes).toBe(2077); await f.lock.release();
});
it.each(['size', 'free'])('rejects the initial %s budget before starting work', async mode => {
  const f = await fixture(); const observed = await observeBudget(f.paths, f.limits);
  const config: ManagedSourceConfig = { ...f.limits, ...(mode === 'size' ? { maxBytes: observed.bytes - 1 } : { minFreeBytes: Number.MAX_SAFE_INTEGER }) };
  const monitor = new BudgetMonitor(f.paths, config); let started = false;
  await expect(monitor.run(async () => { started = true; })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
  expect(started).toBe(false); expect(monitor.summary().sampleCount).toBe(1); await f.lock.release();
});
it('cancels a real growing writer and completes its final observation', async () => {
  const f = await fixture(), observed = await observeBudget(f.paths, f.limits);
  const monitor = new BudgetMonitor(f.paths, { ...f.limits, maxBytes: observed.bytes + 2048 });
  const path = resolve(f.paths.slotRoot, 'writer-data');
  let closed = false;
  await expect(monitor.run(async signal => {
    const child = spawn(process.execPath, ['-e', 'const fs=require("node:fs");setInterval(()=>fs.appendFileSync(process.argv[1],Buffer.alloc(512)),40)', path], { shell: false, windowsHide: true, signal, stdio: 'ignore' });
    await new Promise<void>((accept, reject) => { child.once('error', error => { if (!signal.aborted) reject(error); }); child.once('close', () => { closed = true; accept(); }); });
  })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
  expect(closed).toBe(true); const size = (await readFile(path)).length;
  await new Promise(accept => setTimeout(accept, 100)); expect((await readFile(path)).length).toBe(size);
  expect(monitor.summary()).toMatchObject({ observationsComplete: true });
  expect(monitor.summary().maxObservedBytes).toBeGreaterThan(observed.bytes + 2048);
  await f.lock.release();
});
it('rejects an external junction instead of ignoring its bytes', async () => {
  const f = await fixture(); await symlink(f.root, resolve(f.paths.slotRoot, 'outside'), 'junction');
  await expect(observeBudget(f.paths, f.limits)).rejects.toMatchObject({ code: 'BUDGET_UNKNOWN' });
});
it('observes a dangling internal install junction and later counts its materialized target', async () => {
  const f = await fixture(), root = f.paths.slotRoot;
  const parent = resolve(root, 'checkout/node_modules'), target = resolve(parent, '.pnpm/fixture/node_modules/dependency');
  await mkdir(parent, { recursive: true });
  const before = await observeBudget(f.paths, f.limits);
  const path = resolve(parent, 'dependency'); await symlink(target, path, 'junction');
  const pending = await observeBudget(f.paths, f.limits);
  expect(pending.bytes).toBe(before.bytes + (await lstat(path)).size);
  await f.writeAnchor();
  const beforeTarget = await observeBudget(f.paths, f.limits);
  await mkdir(target, { recursive: true }); await writeFile(resolve(target, 'data'), Buffer.alloc(1234));
  expect((await observeBudget(f.paths, f.limits)).bytes - beforeTarget.bytes).toBe(1234);
  await f.lock.release();
});
it.each(['direct', 'ancestor', 'cycle'])('rejects a dangling link with unsafe %s resolution', async mode => {
  const f = await fixture(), root = f.paths.slotRoot;
  if (mode === 'ancestor') await symlink(f.root, resolve(root, 'ancestor'), 'junction');
  const target = mode === 'direct' ? resolve(f.root, 'missing') : mode === 'ancestor' ? resolve(root, 'ancestor/missing') : resolve(root, 'pending');
  await symlink(target, resolve(root, 'pending'), 'junction');
  await expect(observeBudget(f.paths, f.limits)).rejects.toMatchObject({ code: 'BUDGET_UNKNOWN' });
});
it('does not collapse a parent component before resolving an existing symlink ancestor', async () => {
  const f = await fixture(), root = f.paths.slotRoot;
  await mkdir(resolve(root, 'deep'));
  await symlink(root, resolve(root, 'deep/alias'), 'junction');
  await symlink('deep/alias/../missing', resolve(root, 'pending'), 'dir');
  await expect(observeBudget(f.paths, f.limits)).rejects.toMatchObject({ code: 'BUDGET_UNKNOWN' });
});
it('allows ordinary pnpm parent components before a missing internal dependency', async () => {
  const f = await fixture(), parent = resolve(f.paths.slotRoot, 'checkout/node_modules/.pnpm/source/node_modules');
  await mkdir(parent, { recursive: true });
  await symlink('../../dependency/node_modules/pkg', resolve(parent, 'pkg'), 'dir');
  await expect(observeBudget(f.paths, f.limits)).resolves.toMatchObject({ bytes: expect.any(Number) });
  await f.lock.release();
});
it('fails closed on an observation error and does not overlap samples', async () => {
  const f = await fixture(); let active = 0, peak = 0, calls = 0;
  const monitor = new BudgetMonitor(f.paths, f.limits, async (paths, config) => {
    active++; peak = Math.max(peak, active);
    try { if (++calls === 2) throw new Error('controlled observation failure'); return await observeBudget(paths, config); }
    finally { active--; }
  });
  await expect(monitor.run(async signal => { await new Promise<void>(accept => signal.addEventListener('abort', () => accept(), { once: true })); })).rejects.toMatchObject({ code: 'BUDGET_UNKNOWN' });
  expect(peak).toBe(1); expect(calls).toBe(3); expect(monitor.summary().observationsComplete).toBe(false);
  await f.lock.release();
});
it('restarts the whole observation after a transient directory entry disappears', async () => {
  const f = await fixture(); let attempts = 0;
  const observed = await observeBudget(f.paths, f.limits, async (paths, signal) => {
    if (++attempts === 1) throw new ReleaseError('BUDGET_UNKNOWN', { reason: 'IO_OBSERVATION', ioCode: 'ENOENT' });
    return measureManagedUsage(paths, signal);
  });
  expect(attempts).toBe(2); expect(observed.bytes).toBeGreaterThan(0); await f.lock.release();
});
