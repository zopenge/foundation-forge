import { mkdir, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setImmediate as tick } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { observeBudget } from '../src/node/managed-budget.js';
import { measureManagedUsageOnce } from '../src/node/managed-io.js';
import { record, ReleaseError } from '../src/node/errors.js';
import { ScanFailureWitness } from '../src/node/managed-scan-witness.js';
import { managedBudgetFixture } from './helpers/managed-budget-fixture.js';

const checkpoint = vi.hoisted(() => {
  const idle: (path: string) => Promise<void> = async () => {};
  return { before: idle, after: idle, canonical: idle, ordered: '', calls: [] as string[], opened: [] as import('node:fs').Dir[] };
});
vi.mock('node:fs/promises', async importOriginal => {
  const native = await importOriginal<typeof import('node:fs/promises')>();
  return { ...native,
    lstat: async (...args: Parameters<typeof native.lstat>) => {
      checkpoint.calls.push(`lstat:${String(args[0])}`);
      await checkpoint.before(String(args[0])); const value = await native.lstat(...args);
      await checkpoint.after(String(args[0])); return value;
    },
    realpath: async (...args: Parameters<typeof native.realpath>) => {
      checkpoint.calls.push(`realpath:${String(args[0])}`);
      const value = await native.realpath(...args); await checkpoint.canonical(String(args[0])); return value;
    },
    opendir: async (...args: Parameters<typeof native.opendir>) => {
      checkpoint.calls.push(`opendir:${String(args[0])}`);
      const directory = await native.opendir(...args); checkpoint.opened.push(directory);
      if (String(args[0]) === checkpoint.ordered) {
        const iterate = directory[Symbol.asyncIterator].bind(directory);
        directory[Symbol.asyncIterator] = async function* () {
          const entries = []; for await (const entry of { [Symbol.asyncIterator]: iterate }) entries.push(entry);
          for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) yield entry;
        };
      }
      return directory;
    },
    readlink: async (...args: Parameters<typeof native.readlink>) => { checkpoint.calls.push(`readlink:${String(args[0])}`); return native.readlink(...args); },
    statfs: async (...args: Parameters<typeof native.statfs>) => { checkpoint.calls.push(`statfs:${String(args[0])}`); return native.statfs(...args); },
  };
});
const fixtures: Awaited<ReturnType<typeof managedBudgetFixture>>[] = [];
const active = new Set<Promise<unknown>>();
const releases = new Set<() => void>();
const releaseGates = () => { for (const release of releases) release(); releases.clear(); };
const track = <T>(task: Promise<T>): Promise<T> => { active.add(task); void task.catch(() => {}); return task; };
const drain = async () => {
  releaseGates();
  while (active.size) { const tasks = [...active]; active.clear(); await Promise.allSettled(tasks); }
};
const gate = () => {
  let release = () => {}; const promise = new Promise<void>(accept => { release = accept; });
  releases.add(release); return { promise, release };
};
const failure = async (task: Promise<unknown>): Promise<ReleaseError> => {
  try { await task; } catch (error) { if (error instanceof ReleaseError) return error; throw error; }
  throw new Error('expected observation failure');
};
const prepare = async () => {
  const fixture = await managedBudgetFixture(); fixtures.push(fixture); await mkdir(fixture.paths.checkoutRoot);
  return { ...fixture, limits: { ...fixture.limits, sampleIntervalMs: 1000 } };
};
const attempts = (error: ReleaseError) => {
  const values = error.details.scanAttemptDiagnostics;
  if (!Array.isArray(values)) throw new Error('missing attempt diagnostics');
  return values.map(record);
};
const until = async (condition: () => boolean, finished: Promise<unknown>) => {
  const end = Date.now() + 3000; let stopped = false;
  const checking = (async () => { while (!stopped && !condition()) { if (Date.now() >= end) throw new Error('scan checkpoint not reached'); await tick(); } })();
  try { await Promise.race([checking, finished.then(() => { throw new Error('scan ended before checkpoint'); })]); }
  finally { stopped = true; await Promise.allSettled([checking]); }
};
afterEach(async () => {
  await drain();
  checkpoint.before = async () => {}; checkpoint.after = async () => {}; checkpoint.canonical = async () => {}; checkpoint.ordered = '';
  vi.useRealTimers(); vi.restoreAllMocks();
  const errors: unknown[] = [];
  for (const directory of checkpoint.opened.splice(0)) {
    try { await expect(directory.close()).rejects.toMatchObject({ code: 'ERR_DIR_CLOSED' }); } catch (error) { errors.push(error); }
  }
  checkpoint.calls.length = 0;
  for (const fixture of fixtures.splice(0)) {
    try { await fixture.lock.release(); } catch (error) { errors.push(error); }
    try { await fixture.dispose(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'scan witness fixture cleanup failed');
});

it('keeps ordinary missing internal link fallback free of failure witnesses, new clocks, and extra I/O', async () => {
  const fixture = await prepare(); await symlink(resolve(fixture.paths.checkoutRoot, 'missing'), resolve(fixture.paths.checkoutRoot, 'link'), 'junction');
  checkpoint.calls.length = 0; const baseline = await measureManagedUsageOnce(fixture.paths); const calls = [...checkpoint.calls].sort();
  const witness = new ScanFailureWitness(0), now = vi.spyOn(performance, 'now').mockReturnValue(0);
  checkpoint.calls.length = 0;
  expect((await measureManagedUsageOnce(fixture.paths, undefined, { entriesVisited: 0, phase: 'scan', failureWitness: witness })).bytes).toBe(baseline.bytes);
  expect([...checkpoint.calls].sort()).toEqual(calls); expect(now).not.toHaveBeenCalled(); expect(witness.snapshot()).toEqual({});
});

it('records a nonzero second-attempt origin independently from delayed first-attempt drain', async () => {
  const fixture = await prepare(), bad = resolve(fixture.paths.checkoutRoot, 'a-bad'), hold = resolve(fixture.paths.checkoutRoot, 'z-hold');
  await writeFile(bad, 'bad'); await writeFile(hold, 'hold'); checkpoint.ordered = fixture.paths.checkoutRoot;
  const entered = gate(), held = gate(); let now = 100, state: ScanFailureWitness | undefined, calls = 0;
  checkpoint.before = async path => { if (path === bad) { await entered.promise; await unlink(bad); } };
  checkpoint.after = async path => { if (path === hold) { entered.release(); await held.promise; } };
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const selected = new ReleaseError('BUDGET_UNKNOWN', { reason: 'OBSERVATION_FAILED' });
  const task = failure(observeBudget(fixture.paths, fixture.limits, async (...args) => {
    const attempt = ++calls; state = args[2]?.failureWitness; expect(state).toBeDefined(); now = attempt === 1 ? 110 : 1010;
    try { return await track(measureManagedUsageOnce(...args)); }
    catch (error) { if (attempt === 2) throw selected; throw error; }
    finally { if (attempt === 1) { await writeFile(bad, 'fresh'); now = 1000; } }
  })); active.add(task);
  try {
    await until(() => !!state?.snapshot().first, task);
    expect(state?.snapshot().first?.observedOffsetMs).toBe(10);
    now = 900; held.release(); const error = await task;
    expect(error.details.reason).toBe('OBSERVATION_FAILED');
    expect(attempts(error)).toMatchObject([
      { startedOffsetMs: 0, elapsedMs: 900, failureWitness: { first: { observedOffsetMs: 10 }, selection: 'first' } },
      { startedOffsetMs: 900, elapsedMs: 10, failureWitness: { first: { observedOffsetMs: 10 }, selection: 'different' } },
    ]);
  } finally { await drain(); await Promise.allSettled([task]); }
});

it('labels an anchor disappearance at scan-catch instead of inventing an earlier failure latch', async () => {
  const fixture = await prepare(); await writeFile(fixture.paths.anchorPath, '{}'); let changed = false;
  checkpoint.after = async path => { if (path === fixture.paths.anchorPath && !changed) { changed = true; await unlink(path); } };
  const witness = new ScanFailureWitness(0), now = vi.spyOn(performance, 'now').mockReturnValue(50);
  const error = await failure(measureManagedUsageOnce(fixture.paths, undefined, { entriesVisited: 0, phase: 'scan', failureWitness: witness }));
  expect(error.details).toMatchObject({ reason: 'IO_OBSERVATION', ioCode: 'ENOENT' });
  expect(witness.snapshot(error, true)).toMatchObject({ first: {
    boundary: 'scan-catch', observedOffsetMs: 50, operation: 'lstat', role: 'managed-control', ioCode: 'ENOENT' }, selection: 'first' });
  expect(now).toHaveBeenCalledTimes(1);
});

it('keeps a later selected replacement error distinct from the original failed scan', async () => {
  const fixture = await prepare(), victim = resolve(fixture.paths.checkoutRoot, 'entry'); await writeFile(victim, 'owned');
  checkpoint.before = async path => { if (path === victim) await unlink(victim); };
  const replacement = new ReleaseError('BUDGET_UNKNOWN', { reason: 'OBSERVATION_FAILED' });
  const error = await failure(observeBudget(fixture.paths, fixture.limits, async (...args) => {
    try { return await track(measureManagedUsageOnce(...args)); } catch { throw replacement; }
  }));
  expect(error.details.reason).toBe('OBSERVATION_FAILED');
  expect(attempts(error)[0]).toMatchObject({ failure: { reason: 'OBSERVATION_FAILED' }, failureWitness: {
    first: { reason: 'IO_OBSERVATION', ioCode: 'ENOENT' }, selection: 'different' } });
});

it('does not downgrade an unsafe first cause when a later sibling observes ENOENT', async () => {
  const fixture = await prepare(), link = resolve(fixture.paths.checkoutRoot, 'a-link'), bad = resolve(fixture.paths.checkoutRoot, 'z-bad');
  const target = resolve(fixture.root, 'outside-slot'); await mkdir(target); await symlink(target, link, 'junction'); await writeFile(bad, 'owned');
  checkpoint.ordered = fixture.paths.checkoutRoot; const entered = gate(), held = gate();
  checkpoint.before = async path => { if (path === bad) { entered.release(); await held.promise; await unlink(bad); } };
  checkpoint.after = async path => { if (path === link) await entered.promise; };
  const witness = new ScanFailureWitness(0), now = vi.spyOn(performance, 'now').mockReturnValue(10);
  const task = failure(measureManagedUsageOnce(fixture.paths, undefined, { entriesVisited: 0, phase: 'scan', failureWitness: witness })); active.add(task);
  try {
    await until(() => !!witness.snapshot().first, task); held.release(); const error = await task;
    expect(error.details.reason).toBe('EXTERNAL_LINK');
    expect(witness.snapshot(error, true)).toMatchObject({ first: {
      reason: 'EXTERNAL_LINK', role: 'checkout-payload', operation: 'link-validation' }, blocking: { relation: 'first' }, selection: 'first' });
    expect(now).toHaveBeenCalledTimes(1);
  } finally { await drain(); await Promise.allSettled([task]); }
});

it.each(['before', 'after'] as const)('freezes pending first and unsafe evidence observed %s the original deadline', async when => {
  const fixture = await prepare(), link = resolve(fixture.paths.checkoutRoot, 'a-link'), bad = resolve(fixture.paths.checkoutRoot, 'b-bad');
  const hold = resolve(fixture.paths.checkoutRoot, 'z-hold'), target = resolve(fixture.paths.slotRoot, 'target');
  await mkdir(target); await symlink(target, link, 'junction'); await writeFile(bad, 'bad'); await writeFile(hold, 'hold'); checkpoint.ordered = fixture.paths.checkoutRoot;
  const linkEntered = gate(), holdEntered = gate(), linkHeld = gate(), finalHeld = gate(); let firstLink = true;
  checkpoint.before = async path => { if (path === bad) { await linkEntered.promise; await holdEntered.promise; await unlink(bad); } };
  checkpoint.after = async path => {
    if (path === link && firstLink) { firstLink = false; linkEntered.release(); await linkHeld.promise; }
    if (path === hold) { holdEntered.release(); await finalHeld.promise; }
  };
  let now = 0, state: ScanFailureWitness | undefined; const scans: Promise<unknown>[] = [];
  vi.spyOn(performance, 'now').mockImplementation(() => now); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const task = failure(observeBudget(fixture.paths, fixture.limits, (...args) => {
    state = args[2]?.failureWitness; expect(state).toBeDefined(); now = 100;
    const scan = track(measureManagedUsageOnce(...args)); scans.push(scan); return scan;
  })); active.add(task);
  try {
    await until(() => !!state?.snapshot().first, task);
    await rename(link, resolve(fixture.root, 'old-link')); await symlink(target, link, 'junction');
    if (when === 'before') { now = 500; linkHeld.release(); await until(() => !!state?.snapshot().blocking, task); }
    now = 31000; await vi.advanceTimersByTimeAsync(31000); const error = await task, frozen = JSON.stringify(error.details);
    expect(error.details).toMatchObject({ reason: 'OBSERVATION_DEADLINE', budgetMs: 31000, scanAttempts: 1 });
    const row = attempts(error)[0], witness = record(row?.failureWitness);
    expect(row).toMatchObject({ outcome: 'pending', failureWitness: { first: {
      observedOffsetMs: 100, boundary: 'failure-latch', ioCode: 'ENOENT' } } });
    expect(witness.selection).toBeUndefined();
    if (when === 'before') expect(witness.blocking).toMatchObject({ relation: 'later', reason: 'LINK_REPLACED', observedOffsetMs: 500 });
    else expect(witness.blocking).toBeUndefined();
    now = 32000; linkHeld.release(); finalHeld.release(); await Promise.allSettled(scans);
    expect(state?.snapshot().blocking).toMatchObject({ relation: 'later', reason: 'LINK_REPLACED' });
    expect(JSON.stringify(error.details)).toBe(frozen); expect(vi.getTimerCount()).toBe(0);
  } finally { await drain(); await Promise.allSettled(scans); await Promise.allSettled([task]); }
});

it('preserves caller cancellation and non-UNKNOWN guard authority', async () => {
  const fixture = await prepare(), controller = new AbortController(); controller.abort(); const witness = new ScanFailureWitness(0);
  const error = await failure(measureManagedUsageOnce(fixture.paths, controller.signal, { entriesVisited: 0, phase: 'scan', failureWitness: witness }));
  expect(error.details.reason).toBe('OBSERVATION_DEADLINE');
  expect(witness.snapshot(error, true)).toMatchObject({ first: { reason: 'OBSERVATION_DEADLINE' }, blocking: { relation: 'first' }, selection: 'first' });
  const guard = await failure(observeBudget({ ...fixture.paths, sourceIdentity: { ...fixture.paths.sourceIdentity, ino: '0' } }, fixture.limits));
  expect(guard.code).toBe('SLOT_PATH'); expect(guard.details.scanAttemptDiagnostics).toBeUndefined();
});

it('keeps unknown arguments and unreadable diagnostic fields content-free without replacing the error', async () => {
  const fixture = await prepare(), raw = Object.assign(new Error('PRIVATE_SENTINEL'), { code: 'EACCES', path: resolve(fixture.paths.slotRoot, 'arbitrary'), syscall: 'PRIVATE_SENTINEL' });
  const witness = new ScanFailureWitness(0), now = vi.spyOn(performance, 'now').mockReturnValue(10);
  witness.block(raw, fixture.paths); witness.first(raw, fixture.paths); witness.selected(raw, raw, fixture.paths);
  expect(witness.snapshot(raw, true)).toMatchObject({ first: { operation: 'unknown', role: 'unknown', ioCode: 'EACCES' }, blocking: { relation: 'first' }, selection: 'first' });
  expect(now).toHaveBeenCalledTimes(1); expect(JSON.stringify(witness.snapshot(raw, true))).not.toContain('PRIVATE_SENTINEL');
  const unreadable = Object.assign(new Error('PRIVATE_SENTINEL'), { code: 'ENOENT' });
  Object.defineProperty(unreadable, 'syscall', { get: () => { throw new Error('PRIVATE_SENTINEL'); } });
  const detached = new ScanFailureWitness(0); detached.first(unreadable, fixture.paths); detached.selected(unreadable, unreadable, fixture.paths);
  expect(detached.snapshot(unreadable, true)).toMatchObject({ first: { operation: 'unknown', role: 'unknown', reason: 'OTHER' }, selection: 'first' });
  expect(JSON.stringify(detached.snapshot(unreadable, true))).not.toContain('PRIVATE_SENTINEL');
});

it('classifies only known argument layouts and bounds clocks across repeated first and blocker observations', async () => {
  const fixture = await prepare(), paths = fixture.paths;
  for (const [path, role] of [
    [resolve(paths.checkoutRoot, '.git/entry'), 'checkout-metadata'], [paths.sourceRoot, 'protected-root'],
    [paths.slotRoot, 'protected-root'], [paths.checkoutRoot, 'protected-root'], [paths.statePath, 'managed-control'],
    [resolve(paths.checkoutRoot, 'state.json'), 'checkout-payload'], [resolve(paths.slotRoot, 'arbitrary/state.json'), 'unknown'],
    ['relative-entry', 'unknown'],
  ] as const) {
    const witness = new ScanFailureWitness(0), raw = Object.assign(new Error('PRIVATE_SENTINEL'), { code: 'ENOENT', syscall: 'lstat', path });
    witness.first(raw, paths); expect(witness.snapshot().first?.role).toBe(role);
  }
  const witness = new ScanFailureWitness(0), first = Object.assign(new Error('PRIVATE_SENTINEL'), { code: 'ENOENT' });
  const blocker = new ReleaseError('BUDGET_UNKNOWN', { reason: 'LINK_REPLACED' });
  const now = vi.spyOn(performance, 'now').mockReturnValue(10);
  witness.first(first, paths); witness.first(blocker, paths); witness.block(blocker, paths); witness.block(first, paths);
  witness.selected(first, first, paths); expect(now).toHaveBeenCalledTimes(2);
  expect(witness.snapshot(first, true)).toMatchObject({ first: { ioCode: 'ENOENT' },
    blocking: { relation: 'later', reason: 'LINK_REPLACED' }, selection: 'first' });
});

it.each(['payload', 'control', 'lock-lookalike', 'recovery-lookalike', 'owner-lookalike'] as const)('records a real %s disappearance without changing the original three-attempt cap', async kind => {
  const names = { control: '.state.json.next', 'lock-lookalike': '.run.lock.next', 'recovery-lookalike': '.recover.lock.next', 'owner-lookalike': '.ownership.json.next' };
  const fixture = await prepare(), victim = kind === 'payload' ? resolve(fixture.paths.checkoutRoot, 'entry')
    : resolve(fixture.paths.slotRoot, names[kind]);
  await writeFile(victim, 'owned');
  checkpoint.before = async path => { if (path === victim) {
    if (kind === 'control') await rename(victim, fixture.paths.statePath); else await unlink(victim);
  } };
  let calls = 0;
  const error = await failure(observeBudget(fixture.paths, fixture.limits, async (...args) => {
    calls++; try { return await track(measureManagedUsageOnce(...args)); } finally { await writeFile(victim, 'owned'); }
  }));
  expect(error.details).toMatchObject({ reason: 'IO_OBSERVATION', ioCode: 'ENOENT', scanAttempts: 3 });
  expect(calls).toBe(3); const rows = attempts(error); expect(rows).toHaveLength(3);
  for (const row of rows) {
    expect(row.failureWitness).toMatchObject({ first: { boundary: 'failure-latch', operation: 'lstat',
      role: kind === 'payload' ? 'checkout-payload' : kind === 'control' ? 'managed-control' : 'unknown', reason: 'IO_OBSERVATION', ioCode: 'ENOENT' }, selection: 'first' });
    const witness = record(row.failureWitness), first = record(witness.first);
    expect(witness.blocking).toBeUndefined(); expect(first.observedOffsetMs).toBeGreaterThanOrEqual(0);
    if (typeof row.elapsedMs !== 'number') throw new Error('missing attempt elapsed time');
    expect(first.observedOffsetMs).toBeLessThanOrEqual(row.elapsedMs);
  }
  for (const value of [victim, fixture.root, 'owned', 'PRIVATE_SENTINEL']) expect(JSON.stringify(rows)).not.toContain(value);
});

it('retains a later unsafe blocker separately from the first directory failure', async () => {
  const fixture = await prepare(), link = resolve(fixture.paths.checkoutRoot, 'a-link'), directory = resolve(fixture.paths.checkoutRoot, 'z-directory');
  const leaf = resolve(directory, 'entry'), target = resolve(fixture.paths.slotRoot, 'target');
  await mkdir(directory); await mkdir(target); await symlink(target, link, 'junction'); await writeFile(leaf, 'owned');
  const entered = gate(), held = gate(); checkpoint.ordered = fixture.paths.checkoutRoot; let firstLink = true, changed = false;
  checkpoint.after = async path => {
    if (path === link && firstLink) { firstLink = false; entered.release(); await held.promise; }
    if (path === leaf && !changed) {
      changed = true; await entered.promise;
      await rename(link, resolve(fixture.root, 'old-link')); await symlink(target, link, 'junction');
      await rename(directory, resolve(fixture.root, 'old-directory')); await mkdir(directory); await writeFile(leaf, 'new');
    }
  };
  checkpoint.canonical = async path => { if (path === directory) held.release(); };
  const task = failure(observeBudget(fixture.paths, fixture.limits, (...args) => track(measureManagedUsageOnce(...args)))); active.add(task);
  try {
    const error = await task;
    expect(error.details).toMatchObject({ reason: 'DIRECTORY_REPLACED', change: 'identity', rescanBlockedBy: 'LINK_REPLACED', scanAttempts: 1 });
    expect(attempts(error)[0]).toMatchObject({ retried: false, failureWitness: {
      first: { reason: 'DIRECTORY_REPLACED', operation: 'directory-validation', role: 'checkout-payload' },
      blocking: { relation: 'later', reason: 'LINK_REPLACED', operation: 'link-validation', role: 'checkout-payload' }, selection: 'first' } });
  } finally { await drain(); await Promise.allSettled([task]); }
});

it.each(['syscall', 'path', 'reason'] as const)('reads a changing %s diagnostic getter once before validating its value', async field => {
  const fixture = await prepare(), details = {};
  const error = field === 'reason' ? new ReleaseError('BUDGET_UNKNOWN', details) : Object.assign(new Error('PRIVATE_SENTINEL'), { code: 'ENOENT' });
  const target = field === 'reason' ? details : error; let reads = 0;
  const first = field === 'syscall' ? 'lstat' : field === 'path' ? resolve(fixture.paths.checkoutRoot, 'entry') : 'IO_OBSERVATION';
  Object.defineProperty(target, field, { get: () => ++reads === 1 ? first : 'PRIVATE_SENTINEL' });
  const witness = new ScanFailureWitness(0); witness.first(error, fixture.paths); witness.selected(error, error, fixture.paths);
  const result = witness.snapshot(error, true);
  expect(reads).toBe(1); expect(JSON.stringify(result)).not.toContain('PRIVATE_SENTINEL');
  expect(result.first).toMatchObject(field === 'syscall' ? { operation: 'lstat' } : field === 'path' ? { role: 'checkout-payload' } : { reason: 'IO_OBSERVATION' });
});

it('releases unentered gates and drains real scan promises after an outer observation already settled', async () => {
  const entered = gate(), held = gate(); let settled = false;
  const scan = track((async () => { await entered.promise; await held.promise; settled = true; })());
  await track(Promise.resolve()); expect(settled).toBe(false);
  const draining = drain();
  try {
    await Promise.race([draining, tick().then(() => { if (!settled) throw new Error('unentered gate was not released before drain'); })]);
    expect(settled).toBe(true); expect(active.size).toBe(0);
  } finally { entered.release(); held.release(); await Promise.allSettled([scan, draining]); }
});
