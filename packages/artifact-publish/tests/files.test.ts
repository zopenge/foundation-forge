import { mkdir, mkdtemp, rm, symlink, writeFile, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publishArtifactFiles } from '../src/node.js';
import type { ArtifactFilePublicationOptions } from '../src/node.js';
import { MemoryTransport, options, plan } from './memory-transport.js';

const tracked = vi.hoisted((): { handles: FileHandle[] } => ({ handles: [] }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    tracked.handles.push(handle);
    return handle;
  } };
});

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const fileOptions: ArtifactFilePublicationOptions = { ...options, pathCaseSensitivity: 'case-sensitive' };
let directory: string;
let source: string;

const filePlan = () => {
  const input = plan();
  return { ...input, objects: input.objects.map(({ bytes, ...value }) => {
    void bytes;
    return { ...value, path: value.key.slice(value.key.lastIndexOf('/') + 1) };
  }) };
};

beforeEach(async () => {
  await mkdir(resolve(repositoryRoot, '.tmp'), { recursive: true });
  directory = await mkdtemp(resolve(repositoryRoot, '.tmp', 'apf-'));
  source = resolve(directory, 's');
  await mkdir(source);
  await writeFile(resolve(source, 'one.bin'), 'one');
  await writeFile(resolve(source, 'two.bin'), 'two');
});

afterEach(async () => {
  for (const handle of tracked.handles) if (handle.fd >= 0) await handle.close();
  tracked.handles.length = 0;
  await rm(directory, { recursive: true, force: true });
});

describe('controlled file publication', () => {
  it('uploads frozen file bytes and closes actual file handles before storage access', async () => {
    const storage = new MemoryTransport();
    storage.prepare = async () => {
      expect(tracked.handles).toHaveLength(2);
      for (const handle of tracked.handles) await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' });
      await writeFile(resolve(source, 'one.bin'), 'changed after snapshot');
    };
    await expect(publishArtifactFiles(storage, source, filePlan(), fileOptions)).resolves.toMatchObject({ outcome: 'succeeded', closure: { status: 'closed' } });
    expect(storage.objects.get('releases/a/one.bin')?.bytes).toEqual(new TextEncoder().encode('one'));
    expect(storage.objects.get('current.json')?.bytes).toEqual(new TextEncoder().encode('{"release":"a"}'));
  });

  it.each(['short', 'long', 'digest'])('rejects %s input integrity before network activity', async kind => {
    const input = filePlan();
    const first = input.objects[0];
    if (!first) throw new Error('missing fixture');
    if (kind === 'short') first.byteLength = 2;
    else if (kind === 'long') first.byteLength = 4;
    else first.sha256 = '0'.repeat(64);
    const storage = new MemoryTransport();
    await expect(publishArtifactFiles(storage, source, input, fileOptions)).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' });
    expect(storage.events).toEqual(['close']);
    for (const handle of tracked.handles) await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' });
  });

  it('requires an absolute controlled root', async () => {
    const storage = new MemoryTransport();
    await expect(publishArtifactFiles(storage, 'relative-root', filePlan(), fileOptions)).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
    expect(tracked.handles).toHaveLength(0);
    expect(storage.events).toEqual(['close']);
  });

  it.each(['../outside.bin', '/absolute.bin', 'a\\b.bin'])('rejects unsafe relative source path %s', async path => {
    const input = filePlan();
    const first = input.objects[0];
    if (!first) throw new Error('missing fixture');
    first.path = path;
    const storage = new MemoryTransport();
    await expect(publishArtifactFiles(storage, source, input, fileOptions)).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
    expect(tracked.handles).toHaveLength(0);
    expect(storage.objects.size).toBe(0);
  });

  it('rejects file-path aliases under the declared case policy', async () => {
    const input = filePlan();
    const second = input.objects[1];
    if (!second) throw new Error('missing fixture');
    second.path = 'ONE.bin';
    const storage = new MemoryTransport();
    await expect(publishArtifactFiles(storage, source, input, { ...fileOptions, pathCaseSensitivity: 'case-insensitive' })).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
    expect(tracked.handles).toHaveLength(0);
    expect(storage.events).toEqual(['close']);
  });

  it('rejects a junction or symlink ancestor even when its target remains inside the fixture', async () => {
    const outside = resolve(directory, 'other');
    await mkdir(outside);
    await writeFile(resolve(outside, 'one.bin'), 'one');
    await symlink(outside, resolve(source, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    const input = filePlan();
    const first = input.objects[0];
    if (!first) throw new Error('missing fixture');
    first.path = 'alias/one.bin';
    const storage = new MemoryTransport();
    await expect(publishArtifactFiles(storage, source, input, fileOptions)).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
    expect(storage.objects.size).toBe(0);
    expect(storage.closed).toBe(true);
  });

  it('rejects directories instead of treating them as files', async () => {
    await mkdir(resolve(source, 'dir'));
    const input = filePlan();
    const first = input.objects[0];
    if (!first) throw new Error('missing fixture');
    first.path = 'dir';
    const storage = new MemoryTransport();
    await expect(publishArtifactFiles(storage, source, input, fileOptions)).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
    expect(storage.events).toEqual(['close']);
  });

  it('does not read files or publish when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const storage = new MemoryTransport();
    await expect(publishArtifactFiles(storage, source, filePlan(), { ...fileOptions, signal: controller.signal })).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
    expect(tracked.handles).toHaveLength(0);
    expect(storage.events).toEqual(['close']);
  });
});
