import { lstat, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi, type TestContext } from 'vitest';
import { measureManagedUsage, measureManagedUsageOnce, readManagedDirectoryNames } from '../src/node/managed-io.js';
import { observeBudget } from '../src/node/managed-budget.js';
import { managedBudgetFixture } from './helpers/managed-budget-fixture.js';

const checkpoint = vi.hoisted(() => {
  const afterStat: (path: string) => Promise<void> = async () => {};
  return { path: '', expandDirectory: '', orderedDirectory: '', canonicalPath: '', queuedPrefix: '', nestedDirectory: '',
    queued: Promise.resolve(), releaseQueued: () => {}, pause: async () => {}, canonicalPause: async () => {}, afterStat };
});
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, opendir: async (...args: Parameters<typeof fs.opendir>) => {
    const directory = await fs.opendir(...args);
    if (args[0] === checkpoint.nestedDirectory) {
      const iterate = directory[Symbol.asyncIterator].bind(directory), release = checkpoint.releaseQueued;
      directory[Symbol.asyncIterator] = async function* () {
        try { for await (const entry of { [Symbol.asyncIterator]: iterate }) yield entry; }
        finally { setImmediate(release); }
      };
    }
    if (args[0] === checkpoint.orderedDirectory) {
      const iterate = directory[Symbol.asyncIterator].bind(directory);
      directory[Symbol.asyncIterator] = async function* () {
        const entries: Dirent[] = [];
        for await (const entry of { [Symbol.asyncIterator]: iterate }) entries.push(entry);
        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) yield entry;
      };
    }
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
    if (checkpoint.queuedPrefix && String(args[0]).startsWith(checkpoint.queuedPrefix)) await checkpoint.queued;
    const value = await fs.lstat(...args);
    if (args[0] === checkpoint.path) await checkpoint.pause();
    await checkpoint.afterStat(String(args[0]));
    return value;
  }, realpath: async (...args: Parameters<typeof fs.realpath>) => {
    const value = await fs.realpath(...args);
    if (args[0] === checkpoint.canonicalPath) await checkpoint.canonicalPause();
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
  // Vitest 超时会先进入 afterEach；替换写入与扫描都排空后才能回收私有目录。
  const settled = await Promise.allSettled([...activeTests]); activeTests.clear();
  const errors: unknown[] = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  checkpoint.path = ''; checkpoint.expandDirectory = ''; checkpoint.pause = async () => {};
  checkpoint.orderedDirectory = ''; checkpoint.canonicalPath = ''; checkpoint.canonicalPause = async () => {}; checkpoint.afterStat = async () => {};
  checkpoint.releaseQueued(); checkpoint.queuedPrefix = ''; checkpoint.nestedDirectory = ''; checkpoint.queued = Promise.resolve(); checkpoint.releaseQueued = () => {};
  for (const fixture of fixtures.splice(0)) {
    try { await fixture.lock.release(); } catch (error) { errors.push(error); }
    try { await fixture.dispose(); } catch (error) { errors.push(error); }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'directory scan test or fixture cleanup failed');
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

it('discards a replaced regular checkout subtree and counts only a fresh whole scan', async () => {
  const fixture = await managedBudgetFixture(); fixtures.push(fixture);
  const source = resolve(fixture.paths.checkoutRoot, 'node_modules/pkg'), marker = resolve(source, 'entry');
  await mkdir(source, { recursive: true }); await writeFile(marker, 'old');
  const lockBytes = (await lstat(fixture.paths.lockPath)).size;
  checkpoint.path = marker;
  checkpoint.pause = async () => {
    checkpoint.path = '';
    await rename(source, resolve(fixture.root, 'old-package'));
    await mkdir(source); await writeFile(marker, 'fresh-owned-data');
  };
  let attempts = 0;
  const value = await measureManagedUsage(fixture.paths, undefined, async (...args) => {
    attempts++; return measureManagedUsageOnce(...args);
  });
  expect(value.bytes).toBe(lockBytes + 16); expect(attempts).toBe(2);
});

it('keeps repeated regular subtree replacement unknown after the original two retries', async () => {
  const fixture = await managedBudgetFixture(); fixtures.push(fixture);
  const source = resolve(fixture.paths.checkoutRoot, 'node_modules/pkg'), marker = resolve(source, 'entry');
  await mkdir(source, { recursive: true }); await writeFile(marker, 'old');
  let attempts = 0;
  checkpoint.path = marker;
  checkpoint.pause = async () => {
    await rename(source, resolve(fixture.root, `old-${String(attempts)}`));
    await mkdir(source); await writeFile(marker, 'replacement');
  };
  await expect(observeBudget(fixture.paths, fixture.limits, async (...args) => {
    attempts++; return measureManagedUsageOnce(...args);
  })).rejects.toMatchObject({ code: 'BUDGET_UNKNOWN', details: {
    reason: 'DIRECTORY_REPLACED', change: 'identity', scope: 'checkout-entry',
    entry: expect.stringMatching(/checkout[/\\]node_modules[/\\]pkg/u),
    before: { dev: expect.any(String), ino: expect.any(String) }, after: { dev: expect.any(String), ino: expect.any(String) },
    scanAttempts: 3, entriesVisited: expect.any(Number), phase: expect.any(String),
    budgetMs: 30_250, elapsedMs: expect.any(Number), observedAt: expect.any(String),
  } });
  expect(attempts).toBe(3);
});

it.each(['checkout-root', 'checkout-metadata', 'slot-entry'])('does not retry replacement of a protected %s directory', async scope => {
  const fixture = await managedBudgetFixture(); fixtures.push(fixture);
  const source = scope === 'checkout-root' ? fixture.paths.checkoutRoot : scope === 'checkout-metadata'
    ? resolve(fixture.paths.checkoutRoot, '.git/objects') : resolve(fixture.paths.slotRoot, 'metadata');
  const marker = resolve(source, 'entry');
  await mkdir(source, { recursive: true }); await writeFile(marker, 'old');
  checkpoint.path = marker;
  checkpoint.pause = async () => {
    checkpoint.path = '';
    await rename(source, resolve(fixture.root, 'old-directory'));
    await mkdir(source); await writeFile(marker, 'replacement');
  };
  let attempts = 0;
  await expect(measureManagedUsage(fixture.paths, undefined, async (...args) => {
    attempts++; return measureManagedUsageOnce(...args);
  })).rejects.toMatchObject({ code: 'BUDGET_UNKNOWN', details: { reason: 'DIRECTORY_REPLACED', change: 'identity', scope } });
  expect(attempts).toBe(1);
});

it('does not rebind a checkout root replaced between discarded scans', async () => {
  const fixture = await managedBudgetFixture(); fixtures.push(fixture);
  const source = resolve(fixture.paths.checkoutRoot, 'pkg'), marker = resolve(source, 'entry');
  await mkdir(source, { recursive: true }); await writeFile(marker, 'old');
  checkpoint.path = marker;
  checkpoint.pause = async () => {
    checkpoint.path = ''; await rename(source, resolve(fixture.root, 'old-package'));
    await mkdir(source); await writeFile(marker, 'replacement');
  };
  let attempts = 0;
  await expect(measureManagedUsage(fixture.paths, undefined, async (...args) => {
    attempts++;
    try { return await measureManagedUsageOnce(...args); }
    catch (error) {
      await rename(fixture.paths.checkoutRoot, resolve(fixture.root, 'old-checkout'));
      await mkdir(fixture.paths.checkoutRoot); throw error;
    }
  })).rejects.toMatchObject({ code: 'BUDGET_UNKNOWN', details: { reason: 'DIRECTORY_REPLACED', scope: 'checkout-root' } });
  expect(attempts).toBe(1);
});

it('keeps cancellation visible while the final checkout identity guard is pending', async () => {
  const fixture = await managedBudgetFixture(); fixtures.push(fixture);
  await mkdir(fixture.paths.checkoutRoot);
  const controller = new AbortController();
  await expect(measureManagedUsage(fixture.paths, controller.signal, async (...args) => {
    const value = await measureManagedUsageOnce(...args);
    checkpoint.path = fixture.paths.checkoutRoot; checkpoint.pause = async () => { controller.abort(); };
    return value;
  })).rejects.toMatchObject({ code: 'BUDGET_UNKNOWN', details: { reason: 'OBSERVATION_DEADLINE' } });
});

it.each(['link', 'namespace', 'type'])('does not retry an eligible subtree with a changed %s', async change => {
  const fixture = await managedBudgetFixture(); fixtures.push(fixture);
  const parent = resolve(fixture.paths.checkoutRoot, 'node_modules'), source = resolve(parent, 'pkg'), marker = resolve(source, 'entry');
  const target = resolve(fixture.paths.slotRoot, 'internal-target');
  await mkdir(source, { recursive: true }); await writeFile(marker, 'old');
  await mkdir(resolve(target, 'pkg'), { recursive: true }); await writeFile(resolve(target, 'pkg/entry'), 'replacement');
  checkpoint.path = marker;
  checkpoint.pause = async () => {
    checkpoint.path = '';
    await rename(change === 'namespace' ? parent : source, resolve(fixture.root, 'old-tree'));
    if (change === 'type') await writeFile(source, 'file in place of directory');
    else await symlink(change === 'link' ? fixture.root : target, change === 'link' ? source : parent, 'junction');
  };
  let attempts = 0;
  await expect(measureManagedUsage(fixture.paths, undefined, async (...args) => {
    attempts++; return measureManagedUsageOnce(...args);
  })).rejects.toMatchObject({ code: 'BUDGET_UNKNOWN', details: { reason: 'DIRECTORY_REPLACED', change, scope: 'checkout-entry' } });
  expect(attempts).toBe(1);
});

it('does not retry replacement of the owned slot root', async () => {
  const fixture = await managedBudgetFixture(); fixtures.push(fixture);
  const moved = resolve(fixture.root, 'original-slot');
  let attempts = 0;
  try {
    await expect(measureManagedUsage(fixture.paths, undefined, async (...args) => {
      attempts++; await rename(fixture.paths.slotRoot, moved); await mkdir(fixture.paths.slotRoot);
      return measureManagedUsageOnce(...args);
    })).rejects.toMatchObject({ code: 'BUDGET_UNKNOWN', details: { reason: 'ROOT_REPLACED' } });
    expect(attempts).toBe(1);
  } finally {
    await rename(fixture.paths.slotRoot, resolve(fixture.root, 'replacement-slot'));
    await rename(moved, fixture.paths.slotRoot);
  }
});

it('rejects a replaced source root even when the original owned slot was moved back', async () => {
  const fixture = await managedBudgetFixture(); fixtures.push(fixture);
  const moved = resolve(fixture.root, 'original-source');
  await expect(measureManagedUsage(fixture.paths, undefined, async (...args) => {
    await rename(fixture.paths.sourceRoot, moved); await mkdir(fixture.paths.sourceRoot);
    await rename(resolve(moved, 'state'), resolve(fixture.paths.sourceRoot, 'state'));
    return measureManagedUsageOnce(...args);
  })).rejects.toMatchObject({ code: 'BUDGET_UNKNOWN', details: { reason: 'ROOT_REPLACED' } });
});

it('retains the first directory failure but forbids a rescan after a sibling link replacement was observed', async () => {
  const fixture = await managedBudgetFixture(); fixtures.push(fixture);
  const parent = fixture.paths.checkoutRoot, link = resolve(parent, 'a-link'), directory = resolve(parent, 'z-directory');
  const marker = resolve(directory, 'entry'), target = resolve(fixture.paths.slotRoot, 'target');
  await mkdir(directory, { recursive: true }); await mkdir(target);
  await symlink(target, link, 'junction'); await writeFile(marker, 'old');
  let enter = () => {}, release = () => {}, attempts = 0, firstLinkRead = true;
  const entered = new Promise<void>(accept => { enter = accept; }), held = new Promise<void>(accept => { release = accept; });
  checkpoint.orderedDirectory = parent;
  checkpoint.afterStat = async path => {
    if (path === link && firstLinkRead) { firstLinkRead = false; enter(); await held; }
  };
  checkpoint.path = marker;
  checkpoint.pause = async () => {
    checkpoint.path = ''; await entered;
    await rename(link, resolve(fixture.root, 'original-link')); await symlink(target, link, 'junction');
    await rename(directory, resolve(fixture.root, 'original-directory')); await mkdir(directory); await writeFile(marker, 'replacement');
  };
  checkpoint.canonicalPath = directory;
  checkpoint.canonicalPause = async () => { checkpoint.canonicalPath = ''; release(); };
  const pending = measureManagedUsage(fixture.paths, undefined, async (...args) => {
    attempts++; return measureManagedUsageOnce(...args);
  }).then(value => ({ value }), (error: unknown) => ({ error }));
  try {
    expect(await pending).toMatchObject({ error: { code: 'BUDGET_UNKNOWN', details: {
      reason: 'DIRECTORY_REPLACED', change: 'identity', rescanBlockedBy: 'LINK_REPLACED',
    } } });
    expect(attempts).toBe(1);
  } finally { release(); await pending; }
});

it('rechecks a pending sibling directory before deciding that the first failure permits a rescan', track(async context => {
  const fixture = await managedBudgetFixture(); fixtures.push(fixture);
  const parent = fixture.paths.checkoutRoot, first = resolve(parent, 'a-directory'), last = resolve(parent, 'z-directory');
  const marker = resolve(last, 'entry'), target = resolve(fixture.paths.slotRoot, 'internal-target');
  await mkdir(first, { recursive: true }); await mkdir(last); await mkdir(target); await writeFile(resolve(target, 'entry'), 'target');
  await writeFile(marker, 'old');
  let enter = () => {}, release = () => {}, attempts = 0, firstRead = true;
  const entered = new Promise<void>(accept => { enter = accept; }), held = new Promise<void>(accept => { release = accept; });
  checkpoint.orderedDirectory = parent;
  checkpoint.afterStat = async path => {
    if (path === first && firstRead) { firstRead = false; enter(); await held; }
  };
  checkpoint.path = marker;
  checkpoint.pause = async () => {
    checkpoint.path = ''; await entered;
    await rename(first, resolve(fixture.root, 'original-first')); await symlink(target, first, 'junction');
    await rename(last, resolve(fixture.root, 'original-last')); await mkdir(last); await writeFile(marker, 'replacement');
  };
  checkpoint.canonicalPath = last;
  checkpoint.canonicalPause = async () => { checkpoint.canonicalPath = ''; release(); };
  context.signal.addEventListener('abort', release, { once: true });
  const pending = measureManagedUsage(fixture.paths, context.signal, async (...args) => {
    attempts++; return measureManagedUsageOnce(...args);
  }).then(value => ({ value }), (error: unknown) => ({ error }));
  try {
    expect(await pending).toMatchObject({ error: { code: 'BUDGET_UNKNOWN', details: {
      reason: 'DIRECTORY_REPLACED', change: 'identity', rescanBlockedBy: 'DIRECTORY_REPLACED',
    } } });
    expect(attempts).toBe(1);
  } finally { release(); await pending; context.signal.removeEventListener('abort', release); }
}));

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
  // 虚拟队列没有真实元数据；先让真实嵌套枚举触达预算边界，避免并发下无关 ENOENT 抢先。
  checkpoint.queuedPrefix = resolve(source, 'queued-'); checkpoint.nestedDirectory = resolve(source, 'nested');
  checkpoint.queued = new Promise<void>(accept => { checkpoint.releaseQueued = accept; });
  await expect(measureManagedUsageOnce(fixture.paths)).rejects.toMatchObject({ code: 'BUDGET_UNKNOWN', details: { reason: 'ENTRY_LIMIT' } });
  await rename(source, destination);
  expect(await readFile(resolve(destination, 'nested/b'), 'utf8')).toBe('b');
});
