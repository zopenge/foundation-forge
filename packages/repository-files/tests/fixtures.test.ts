import { lstat, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import * as fixtures from './fixtures.js';

const transport = vi.hoisted((): { fail: boolean; owned?: { root: string; dev: bigint; ino: bigint } } => ({ fail: false }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter } = await import('node:events');
  const { lstatSync } = await import('node:fs');
  return { ...actual, execFile: (...args: Parameters<typeof actual.execFile>) => {
    const options = args[2], callback = args[3];
    if (!transport.fail) return actual.execFile(...args);
    if (typeof options?.cwd !== 'string' || !callback) throw new Error('FIXTURE_COMMAND_INVALID');
    const info = lstatSync(options.cwd, { bigint: true });
    transport.owned = { root: options.cwd, dev: info.dev, ino: info.ino };
    const child = new EventEmitter();
    queueMicrotask(() => { callback(Object.assign(new Error('fixture init failure'), { code: 1 }), '', ''); child.emit('close', 1); });
    return child;
  } };
});

const fixtureBase = resolve(import.meta.dirname, '../../../tmp/repository-files-tests');
async function removeRetainedRoot(): Promise<void> {
  const owned = transport.owned; delete transport.owned;
  if (!owned) return;
  const inside = relative(fixtureBase, owned.root);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('FIXTURE_ROOT_ESCAPED');
  let current;
  try { current = await lstat(owned.root, { bigint: true }); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return; throw error; }
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== owned.dev || current.ino !== owned.ino) throw new Error('FIXTURE_IDENTITY_CHANGED');
  await rm(owned.root, { recursive: true });
}

it('reclaims a newly created repository when Git initialization fails', async () => {
  transport.fail = true;
  try {
    await expect(fixtures.createTestRepository({ signal: new AbortController().signal })).rejects.toBeInstanceOf(Error);
    const owned = transport.owned;
    if (!owned) throw new Error('FIXTURE_OWNERSHIP_MISSING');
    await expect(lstat(owned.root)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { transport.fail = false; await removeRetainedRoot(); }
});

it('rejects an already cancelled fixture before creating a repository or starting Git', async () => {
  transport.fail = true;
  const controller = new AbortController(), reason = new Error('fixture already cancelled'); controller.abort(reason);
  try {
    await expect(fixtures.createTestRepository({ signal: controller.signal })).rejects.toBe(reason);
    expect(transport.owned).toBeUndefined();
  } finally { transport.fail = false; await removeRetainedRoot(); }
});

it('drains the entire test body before removing its repository after cancellation', async testContext => {
  transport.fail = false;
  const handlers: (() => Promise<void>)[] = [];
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(accept => { release = accept; });
  const ready = new Promise<void>(accept => { entered = accept; });
  let root = '', wrote = false, cleaned = false;
  const context = { signal: testContext.signal, onTestFinished: (handler: () => Promise<void>) => { handlers.push(handler); } };
  let work: Promise<void> | undefined, cleanup: Promise<void> | undefined;
  testContext.onTestFinished(async () => {
    release();
    cleanup ??= handlers[0]?.();
    await Promise.allSettled([work]);
    await cleanup;
  }, 15_000);
  try {
    work = fixtures.withTestRepositories(context, async fixture => {
      root = await fixture.createRoot(); entered(); await gate;
      await writeFile(resolve(root, 'late.txt'), 'complete'); wrote = true;
      fixture.signal.throwIfAborted();
    });
    void work.catch(() => {});
    await Promise.race([ready, work]);
    const finish = handlers[0];
    if (!finish) throw new Error('FIXTURE_CLEANUP_MISSING');
    cleanup = finish().then(() => { cleaned = true; });
    await new Promise<void>(accept => setImmediate(accept));
    expect(cleaned).toBe(false); expect((await lstat(root)).isDirectory()).toBe(true);
    release();
    await expect(work).rejects.toBeInstanceOf(Error); await cleanup;
    expect(wrote).toBe(true);
    await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { release(); await Promise.allSettled([work, cleanup]); }
}, 15_000);
