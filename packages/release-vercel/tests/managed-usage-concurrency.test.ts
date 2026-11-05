import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi, type TestContext } from 'vitest';
import { measureManagedUsageOnce } from '../src/node/managed-io.js';
import { managedBudgetFixture } from './helpers/managed-budget-fixture.js';

const checkpoint = vi.hoisted(() => {
  const pause: (path: string) => Promise<void> = async () => {};
  return { prefix: '', start: () => {}, pause };
});
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, lstat: async (...args: Parameters<typeof fs.lstat>) => {
    const tracked = checkpoint.prefix && String(args[0]).startsWith(checkpoint.prefix);
    if (tracked) checkpoint.start();
    const value = await fs.lstat(...args);
    if (tracked) await checkpoint.pause(String(args[0]));
    return value;
  } };
});

const fixtures: Awaited<ReturnType<typeof managedBudgetFixture>>[] = [];
const activeTests = new Set<Promise<void>>();
const track = (operation: (context: TestContext) => Promise<void>) => (context: TestContext) => {
  const task = Promise.resolve().then(() => operation(context));
  activeTests.add(task); void task.catch(() => {}); return task;
};
afterEach(async () => {
  // Vitest 超时后直接进入 afterEach，必须先等原 body 的 finally 排空扫描。
  const settled = await Promise.allSettled([...activeTests]); activeTests.clear();
  const errors: unknown[] = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  checkpoint.prefix = ''; checkpoint.start = () => {}; checkpoint.pause = async () => {};
  for (const fixture of fixtures.splice(0)) {
    try { await fixture.lock.release(); } catch (error) { errors.push(error); }
    try { await fixture.dispose(); } catch (error) { errors.push(error); }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'scan test or fixture cleanup failed');
});
const deferred = () => {
  let release = () => {};
  const promise = new Promise<void>(accept => { release = accept; });
  return { promise, release };
};
const prepare = async () => {
  const fixture = await managedBudgetFixture(); fixtures.push(fixture);
  const directory = resolve(fixture.paths.slotRoot, 'checkout/node_modules/.pnpm/pkg/node_modules/dependency/lib');
  await mkdir(directory, { recursive: true });
  for (let index = 0; index < 12; index++) await writeFile(resolve(directory, `payload-${String(index)}`), 'owned');
  checkpoint.prefix = resolve(directory, 'payload-');
  return fixture;
};
const reachedWithinTest = async (reached: Promise<void>, pending: Promise<unknown>, signal: AbortSignal) => {
  let abort = () => {};
  const cancelled = new Promise<never>((_accept, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try { await Promise.race([reached, cancelled, pending.then(result => {
    throw new Error('scan ended before the parallel metadata checkpoint', { cause: result });
  })]); } finally { signal.removeEventListener('abort', abort); }
};

it('bounds concurrent fresh metadata reads inside a single nested checkout', track(async context => {
  const fixture = await prepare(), held = deferred(), parallel = deferred();
  let active = 0, peak = 0;
  checkpoint.pause = async () => {
    active++; peak = Math.max(peak, active); if (active >= 2) parallel.release();
    try { await held.promise; } finally { active--; }
  };
  const pending = measureManagedUsageOnce(fixture.paths).then(value => ({ value }), (error: unknown) => ({ error }));
  try { await reachedWithinTest(parallel.promise, pending, context.signal); expect(peak).toBeGreaterThan(1); expect(peak).toBeLessThanOrEqual(4); }
  finally { held.release(); await pending; }
  expect(await pending).toMatchObject({ value: { bytes: (await lstat(fixture.paths.lockPath)).size + 60 } });
  expect(active).toBe(0);
}));

it('drains in-flight metadata reads after cancellation before settling the scan', track(async context => {
  const fixture = await prepare(), held = deferred(), parallel = deferred(), controller = new AbortController();
  let active = 0, started = 0, settled = false;
  checkpoint.start = () => { started++; };
  checkpoint.pause = async () => {
    active++; if (active >= 2) parallel.release();
    try { await held.promise; } finally { active--; }
  };
  const pending = measureManagedUsageOnce(fixture.paths, controller.signal).then(value => ({ value }), (error: unknown) => ({ error }))
    .finally(() => { settled = true; });
  let startedAtCancel: number;
  try {
    await reachedWithinTest(parallel.promise, pending, context.signal); controller.abort(); startedAtCancel = started;
    await Promise.resolve(); expect(settled).toBe(false);
  } finally { controller.abort(); held.release(); await pending; }
  expect(await pending).toMatchObject({ error: { code: 'BUDGET_UNKNOWN', details: { reason: 'OBSERVATION_DEADLINE' } } });
  expect(active).toBe(0); expect(started).toBe(startedAtCancel);
}));

it('retains an I/O failure and drains sibling reads before returning it', track(async context => {
  const fixture = await prepare(), held = deferred(), fail = deferred(), parallel = deferred();
  let active = 0, settled = false;
  const error = Object.assign(new Error('controlled metadata failure'), { code: 'EACCES' });
  checkpoint.pause = async () => {
    const first = active === 0; active++; if (active >= 2) parallel.release();
    try { await (first ? fail.promise : held.promise); if (first) throw error; }
    finally { active--; }
  };
  const pending = measureManagedUsageOnce(fixture.paths).then(value => ({ value }), (error: unknown) => ({ error }))
    .finally(() => { settled = true; });
  try {
    await reachedWithinTest(parallel.promise, pending, context.signal); fail.release();
    await new Promise<void>(accept => setImmediate(accept)); expect(settled).toBe(false);
  } finally { fail.release(); held.release(); await pending; }
  expect(await pending).toMatchObject({ error: { code: 'BUDGET_UNKNOWN', details: { reason: 'IO_OBSERVATION', ioCode: 'EACCES' } } });
  expect(active).toBe(0);
}));
