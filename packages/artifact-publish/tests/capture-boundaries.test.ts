import { mkdir, mkdtemp, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { captureArtifactFiles } from '../src/node.js';
import type { ArtifactFileCaptureOptions } from '../src/node.js';

const tracked = vi.hoisted((): {
  handles: FileHandle[]; afterRead: (() => Promise<void>) | undefined; failClose: boolean;
} => ({ handles: [], afterRead: undefined, failClose: false }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args); tracked.handles.push(handle);
    return new Proxy(handle, { get(target, key) {
      if (key === 'read') return async (...readArgs: unknown[]) => {
        const result = await Reflect.apply(target.read, target, readArgs);
        const hook = tracked.afterRead; tracked.afterRead = undefined; await hook?.();
        return result;
      };
      if (key === 'close') return async () => {
        await target.close();
        if (tracked.failClose) throw new Error('private close diagnostic');
      };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
});

let root: string;
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const options = (): ArtifactFileCaptureOptions => ({
  sources: [{ rootDirectory: root, closure: 'exact', files: [{ path: 'payload', sourcePath: 'a', role: 'control' }] }],
  pathCaseSensitivity: 'case-sensitive', maxFiles: 10, maxEntries: 100,
  maxFileBytes: 1024, maxTotalBytes: 4096, maxManifestBytes: 2048, timeoutMilliseconds: 5000,
});
beforeEach(async () => {
  await mkdir(resolve(repositoryRoot, 'tmp'), { recursive: true });
  root = await mkdtemp(resolve(repositoryRoot, 'tmp', 'capb-'));
  await writeFile(resolve(root, 'a'), 'abc');
});
afterEach(async () => {
  tracked.afterRead = undefined; tracked.failClose = false;
  for (const handle of tracked.handles) if (handle.fd >= 0) await handle.close();
  tracked.handles.length = 0;
  await rm(root, { recursive: true, force: true });
});

it.each(['rewrite', 'grow', 'replace'])('rejects a real file %s during capture and closes handles', async kind => {
  tracked.afterRead = async () => {
    if (kind === 'replace') await rm(resolve(root, 'a'));
    await writeFile(resolve(root, 'a'), kind === 'grow' ? 'longer' : 'def');
  };
  await expect(captureArtifactFiles(options())).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' });
  for (const handle of tracked.handles) await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' });
});

it('rejects a file added after the first closure scan', async () => {
  tracked.afterRead = () => writeFile(resolve(root, 'new'), 'new');
  await expect(captureArtifactFiles(options())).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
});

it('rejects cancellation after a real read and closes handles', async () => {
  const controller = new AbortController();
  tracked.afterRead = async () => { controller.abort(); };
  await expect(captureArtifactFiles({ ...options(), signal: controller.signal })).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
  for (const handle of tracked.handles) await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' });
});

it('fails closed with structured diagnostics when file closure is not confirmed', async () => {
  tracked.failClose = true;
  const operation = captureArtifactFiles(options());
  await expect(operation).rejects.toMatchObject({ code: 'CLOSURE_UNCONFIRMED' });
  await expect(operation).rejects.not.toHaveProperty('cause');
});

it('snapshots caller source mappings and response policy before asynchronous work', async () => {
  const headers = { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-cache' };
  const files = [{ path: 'payload', sourcePath: 'a', role: 'asset' as const, responseHeaders: headers }];
  const operation = captureArtifactFiles({ ...options(), sources: [{ rootDirectory: root, closure: 'exact', files }] });
  const first = files[0]; if (!first) throw new Error('missing fixture');
  first.sourcePath = 'missing'; headers['Cache-Control'] = 'modified';
  const result = await operation;
  expect(new TextDecoder().decode(result.readFile('payload'))).toBe('abc');
  expect(result.manifest.files[0]).toMatchObject({ responseHeaders: { 'cache-control': 'no-cache' } });
});
