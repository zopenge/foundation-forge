import { lstat, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { measureManagedUsage, measureManagedUsageOnce, readManagedDirectoryNames } from '../src/node/managed-io.js';
import { managedBudgetFixture } from './helpers/managed-budget-fixture.js';

const checkpoint = vi.hoisted(() => ({ path: '', expandDirectory: '', pause: async () => {} }));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, opendir: async (...args: Parameters<typeof fs.opendir>) => {
    const directory = await fs.opendir(...args);
    if (args[0] === checkpoint.expandDirectory) {
      const iterate = directory[Symbol.asyncIterator].bind(directory);
      directory[Symbol.asyncIterator] = async function* () {
        for await (const entry of { [Symbol.asyncIterator]: iterate }) {
          const originalName = entry.name;
          yield entry;
          if (originalName === 'nested') {
            // 根、锁、队列目录、嵌套目录和两个真实文件共六项；总数恰好超过原上限一项。
            for (let index = 0; index < 499_995; index++) { entry.name = `queued-${String(index)}`; yield entry; }
          }
        }
      };
    }
    return directory;
  }, lstat: async (...args: Parameters<typeof fs.lstat>) => {
    const value = await fs.lstat(...args);
    if (args[0] === checkpoint.path) await checkpoint.pause();
    return value;
  } };
});

const fixtures: Awaited<ReturnType<typeof managedBudgetFixture>>[] = [];
afterEach(async () => {
  checkpoint.path = ''; checkpoint.expandDirectory = ''; checkpoint.pause = async () => {};
  for (const fixture of fixtures.splice(0)) {
    await fixture.lock.release(); await fixture.dispose();
  }
});

it('allows an installer rename and discards the stale observation before retrying', async () => {
  const fixture = await managedBudgetFixture(); fixtures.push(fixture);
  const source = resolve(fixture.paths.slotRoot, 'package_tmp');
  const destination = resolve(fixture.paths.slotRoot, 'package');
  const marker = resolve(source, 'nested/entry');
  await mkdir(resolve(source, 'nested'), { recursive: true });
  await writeFile(marker, 'fixed-owned-data\n');
  const lockBytes = (await lstat(fixture.paths.lockPath)).size;
  let entered = () => {}, release = () => {};
  const reached = new Promise<void>(accept => { entered = accept; });
  const blocked = new Promise<void>(accept => { release = accept; });
  checkpoint.path = marker;
  checkpoint.pause = async () => { checkpoint.path = ''; entered(); await blocked; };
  let attempts = 0;
  const pending = measureManagedUsage(fixture.paths, undefined, async (...args) => {
    attempts++; return measureManagedUsageOnce(...args);
  }).then(value => ({ value }), (error: unknown) => ({ error }));
  let renameError: unknown;
  try {
    await Promise.race([reached, pending.then(result => { throw new Error('observation ended before the controlled child metadata checkpoint', { cause: result }); })]);
    try { await rename(source, destination); } catch (error) { renameError = error; }
  } finally { release(); }
  const result = await pending;
  expect(renameError).toBeUndefined();
  expect(result).toMatchObject({ value: { bytes: lockBytes + 17 } });
  expect(attempts).toBe(2);
});

it('bounds directory names by the remaining shared entry budget and closes on overflow', async () => {
  const fixture = await managedBudgetFixture(); fixtures.push(fixture);
  const source = resolve(fixture.paths.slotRoot, 'bounded'), destination = resolve(fixture.paths.slotRoot, 'overflow-closed');
  await mkdir(source);
  for (const name of ['a', 'b', 'c']) await writeFile(resolve(source, name), name);
  await expect(readManagedDirectoryNames(source, 2)).rejects.toMatchObject({ code: 'BUDGET_UNKNOWN', details: { reason: 'ENTRY_LIMIT' } });
  await rename(source, destination);
  expect(await readFile(resolve(destination, 'c'), 'utf8')).toBe('c');
  expect((await readManagedDirectoryNames(destination, 3)).sort()).toEqual(['a', 'b', 'c']);
  await expect(readManagedDirectoryNames(destination, Infinity)).rejects.toMatchObject({ code: 'BUDGET_UNKNOWN', details: { reason: 'ENTRY_LIMIT' } });
});

it('rejects an observed ancestor replaced with an external junction while child metadata is pending', async () => {
  const fixture = await managedBudgetFixture(); fixtures.push(fixture);
  const source = resolve(fixture.paths.slotRoot, 'package_tmp'), moved = resolve(fixture.paths.slotRoot, 'package');
  const outside = resolve(fixture.root, 'outside');
  await mkdir(resolve(source, 'nested'), { recursive: true }); await mkdir(resolve(outside, 'nested'), { recursive: true });
  for (const name of ['a', 'b']) {
    await writeFile(resolve(source, 'nested', name), 'owned');
    await writeFile(resolve(outside, 'nested', name), 'outside the observed root');
  }
  let entered = () => {}, release = () => {};
  const reached = new Promise<void>(accept => { entered = accept; });
  const blocked = new Promise<void>(accept => { release = accept; });
  checkpoint.path = resolve(source, 'nested/a');
  checkpoint.pause = async () => { checkpoint.path = ''; entered(); await blocked; };
  const pending = measureManagedUsageOnce(fixture.paths).then(value => ({ value }), (error: unknown) => ({ error }));
  try {
    await Promise.race([reached, pending.then(result => { throw new Error('observation ended before controlled ancestor replacement', { cause: result }); })]);
    await rename(source, moved); await symlink(outside, source, 'junction');
  } finally { release(); await pending; }
  expect(await pending).toMatchObject({ error: { code: 'BUDGET_UNKNOWN', details: { reason: 'DIRECTORY_REPLACED' } } });
});

it('closes a directory when cancellation is already visible after open', async () => {
  const fixture = await managedBudgetFixture(); fixtures.push(fixture);
  const source = resolve(fixture.paths.slotRoot, 'cancel'), destination = resolve(fixture.paths.slotRoot, 'cancel-closed');
  await mkdir(source); await writeFile(resolve(source, 'entry'), 'owned');
  const controller = new AbortController(); controller.abort();
  await expect(readManagedDirectoryNames(source, 1, controller.signal)).rejects.toMatchObject({ code: 'BUDGET_UNKNOWN', details: { reason: 'OBSERVATION_DEADLINE' } });
  await rename(source, destination);
  expect(await readFile(resolve(destination, 'entry'), 'utf8')).toBe('owned');
});

it('includes unvisited ancestor names in the global entry limit before expanding a child', async () => {
  const fixture = await managedBudgetFixture(); fixtures.push(fixture);
  const source = resolve(fixture.paths.slotRoot, 'queued'), destination = resolve(fixture.paths.slotRoot, 'queued-closed');
  await mkdir(resolve(source, 'nested'), { recursive: true });
  await writeFile(resolve(source, 'nested/a'), 'a'); await writeFile(resolve(source, 'nested/b'), 'b');
  checkpoint.expandDirectory = source;
  await expect(measureManagedUsageOnce(fixture.paths)).rejects.toMatchObject({ code: 'BUDGET_UNKNOWN', details: { reason: 'ENTRY_LIMIT' } });
  await rename(source, destination);
  expect(await readFile(resolve(destination, 'nested/b'), 'utf8')).toBe('b');
});
