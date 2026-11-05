import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import * as fixtures from './node-fixtures.js';

test('drains a suspended test body before removing its private repository', async () => {
  expect(fixtures.createTestTaskScope).toBeTypeOf('function');
  const scope = fixtures.createTestTaskScope(), events: string[] = [];
  let release: () => void = () => {}, entered: () => void = () => {}, repository: fixtures.TemporaryRepository | undefined;
  const held = new Promise<void>(accept => { release = accept; });
  const ready = new Promise<void>(accept => { entered = accept; });
  const work = scope.run(async () => {
    try { repository = await fixtures.createTemporaryRepository(); } finally { entered(); }
    await held;
    await writeFile(join(repository.rootDir, 'late-write'), 'owned'); events.push('write');
  });
  const finished = (async () => { await ready; const errors = await scope.drain(); expect(errors).toEqual([]);
    events.push('drained'); await repository?.cleanup(); events.push('cleaned'); })();
  try {
    await ready; await Promise.resolve();
    expect(events).toEqual([]); release(); await work; await finished;
    expect(events).toEqual(['write', 'drained', 'cleaned']);
    if (!repository) throw new Error('repository missing');
    await expect(readFile(join(repository.rootDir, 'late-write'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { release(); await Promise.allSettled([work, finished]); await repository?.cleanup(); }
});

test('retains a late body error while draining every active operation', async () => {
  expect(fixtures.createTestTaskScope).toBeTypeOf('function');
  const scope = fixtures.createTestTaskScope(), error = new Error('late original failure');
  let release: () => void = () => {};
  const held = new Promise<void>(accept => { release = accept; });
  const failed = scope.run(async () => { await held; throw error; });
  const observed = failed.catch(value => value);
  const sibling = scope.run(async () => { await held; return 'sibling drained'; });
  const draining = scope.drain(); release();
  expect(await observed).toBe(error); expect(await sibling).toBe('sibling drained');
  expect(await draining).toEqual([error]); expect(await scope.drain()).toEqual([]);
});
