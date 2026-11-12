import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDurableArtifactFilesystem } from '../src/node/durable-filesystem.js';
import { fixture } from './fixtures.js';

vi.mock('node:fs/promises', async () => ({ ...await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises') }));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
const content = new TextEncoder().encode('persisted bytes');
const ioError = () => Object.assign(new Error('injected boundary failure'), { code: 'EIO' });
async function root(): Promise<string> { const value = await fixture(); cleanups.push(value.cleanup); return value.root; }
const deferred = () => {
  let resolve = () => {};
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
};

describe('durability acknowledgement boundaries with real file publication', () => {
  it('waits for the post-publication directory flush before acknowledging', async () => {
    const directory = await root();
    const entered = deferred(), released = deferred();
    let count = 0, settled = false;
    const io = createDurableArtifactFilesystem({ syncDirectory: async () => { if (++count === 2) { entered.resolve(); await released.promise; } } });
    const publication = io.publishBytes(directory, 'value', content, { mode: 'exclusive' }).finally(() => { settled = true; });
    await entered.promise;
    try {
      expect(settled).toBe(false);
      expect(await fs.readFile(join(directory, 'value'))).toEqual(Buffer.from(content));
    } finally { released.resolve(); await publication; }
    expect(settled).toBe(true);
  });
  it('does not publish bytes when the temporary content sync fails', async () => {
    const directory = await root(), original = fs.open;
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args);
      if (args[1] === 'wx') vi.spyOn(handle, 'sync').mockRejectedValueOnce(ioError());
      return handle;
    });
    const io = createDurableArtifactFilesystem({ syncDirectory: async () => {} });
    await expect(io.publishBytes(directory, 'value', content, { mode: 'exclusive' })).rejects.toMatchObject({
      code: 'GENERATED_ARTIFACT_DURABILITY_UNKNOWN', details: { stage: 'content-sync', publication: 'not-published' },
    });
    expect(await fs.readdir(directory)).toEqual([]);
  });
  it('preserves a published target when the post-publication content sync fails', async () => {
    const directory = await root(), original = fs.open;
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args);
      if (args[1] === 'r+') vi.spyOn(handle, 'sync').mockRejectedValueOnce(ioError());
      return handle;
    });
    const io = createDurableArtifactFilesystem({ syncDirectory: async () => {} });
    await expect(io.publishBytes(directory, 'value', content, { mode: 'exclusive' })).rejects.toMatchObject({
      code: 'GENERATED_ARTIFACT_DURABILITY_UNKNOWN', details: { stage: 'published-content-sync', publication: 'unknown' },
    });
    expect(await fs.readFile(join(directory, 'value'))).toEqual(Buffer.from(content));
    expect(await fs.readdir(directory)).toEqual(['value']);
  });
  it('retains a replacement after directory flush failure and reports unknown', async () => {
    const directory = await root(); await fs.writeFile(join(directory, 'value'), 'old');
    let count = 0;
    const io = createDurableArtifactFilesystem({ syncDirectory: async () => { if (++count === 2) throw ioError(); } });
    await expect(io.publishBytes(directory, 'value', content, { mode: 'replace' })).rejects.toMatchObject({
      code: 'GENERATED_ARTIFACT_DURABILITY_UNKNOWN', details: { stage: 'published-directory-sync', publication: 'unknown' },
    });
    expect(await fs.readFile(join(directory, 'value'))).toEqual(Buffer.from(content));
    expect(await fs.readdir(directory)).toEqual(['value']);
  });
  for (const flags of ['wx', 'r+']) {
    it(`refuses success on ${flags} handle close failure`, async () => {
      const directory = await root(), original = fs.open;
      vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await original(...args);
        if (args[1] === flags) {
          const close = handle.close.bind(handle);
          vi.spyOn(handle, 'close').mockImplementationOnce(async () => { await close(); throw ioError(); });
        }
        return handle;
      });
      const io = createDurableArtifactFilesystem({ syncDirectory: async () => {} });
      await expect(io.publishBytes(directory, 'value', content, { mode: 'exclusive' })).rejects.toMatchObject({
        code: 'GENERATED_ARTIFACT_DURABILITY_UNKNOWN', details: { publication: flags === 'wx' ? 'not-published' : 'unknown' },
      });
      expect(await fs.readdir(directory)).toEqual(flags === 'wx' ? [] : ['value']);
    });
  }
  it('flushes existing directory entries again after a prior interrupted attempt', async () => {
    const directory = await root(); await fs.mkdir(join(directory, 'state/nested'), { recursive: true });
    const flushed: string[] = [];
    const io = createDurableArtifactFilesystem({ syncDirectory: async path => { flushed.push(path); } });
    await io.ensureDirectory(directory, 'state/nested');
    expect(flushed).toEqual([directory, join(directory, 'state'), directory, join(directory, 'state/nested'), join(directory, 'state')]);
  });
  it('rejects a different file replacing the target before its post-publication sync', async () => {
    const directory = await root(), original = fs.rename;
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args: Parameters<typeof fs.rename>) => {
      await original(...args);
      await fs.writeFile(join(directory, 'other'), 'superseding writer');
      await original(join(directory, 'other'), join(directory, 'value'));
    });
    const io = createDurableArtifactFilesystem({ syncDirectory: async () => {} });
    await expect(io.publishBytes(directory, 'value', content, { mode: 'replace' })).rejects.toMatchObject({
      code: 'GENERATED_ARTIFACT_DURABILITY_UNKNOWN', details: { publication: 'unknown' },
    });
    expect(await fs.readFile(join(directory, 'value'), 'utf8')).toBe('superseding writer');
  });
  it('keeps distinct 64-bit file IDs distinct beyond Number precision', async () => {
    const directory = await root(), original = fs.open;
    const firstId = 9007199254740992n, nextId = firstId + 1n;
    expect(Number(firstId)).toBe(Number(nextId));
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args), stat = handle.stat.bind(handle);
      vi.spyOn(handle, 'stat').mockImplementation(async options => {
        const actual = await stat(options);
        const ino = args[1] === 'wx' ? firstId : nextId;
        return Object.assign(actual, { ino: options?.bigint ? ino : Number(ino) });
      });
      return handle;
    });
    const io = createDurableArtifactFilesystem({ syncDirectory: async () => {} });
    await expect(io.publishBytes(directory, 'value', content, { mode: 'exclusive' })).rejects.toMatchObject({
      code: 'GENERATED_ARTIFACT_DURABILITY_UNKNOWN', details: { publication: 'unknown' },
    });
    expect(await fs.readFile(join(directory, 'value'))).toEqual(Buffer.from(content));
  });
  it('resynchronizes only the authorized root after an unknown publication', async () => {
    const directory = await root();
    let fail = true;
    const io = createDurableArtifactFilesystem({ syncDirectory: async path => {
      expect(path).toBe(directory);
      if (fail && (await fs.readdir(directory)).includes('value')) throw ioError();
    } });
    await expect(io.publishBytes(directory, 'value', content, { mode: 'exclusive' })).rejects.toMatchObject({ details: { publication: 'unknown' } });
    expect(await fs.readFile(join(directory, 'value'))).toEqual(Buffer.from(content));
    await expect(io.ensureDirectory(directory, '')).rejects.toMatchObject({ code: 'GENERATED_ARTIFACT_DURABILITY_UNKNOWN' });
    fail = false;
    await io.ensureDirectory(directory);
    await io.ensureDirectory(directory, '');
    expect(await fs.readdir(directory)).toEqual(['value']);
    await expect(io.publishBytes(directory, '', content, { mode: 'replace' })).rejects.toMatchObject({ code: 'GENERATED_ARTIFACT_INVALID_PATH' });
  });
});
