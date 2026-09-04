import * as filesystem from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineGeneratedArtifactPlan } from '../src/index.js';
import { inspectGeneratedArtifacts, publishGeneratedArtifacts } from '../src/node.js';
import { fixture, options } from './fixtures.js';

vi.mock('node:fs/promises', async () => ({ ...await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises') }));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function root(): Promise<string> { const value = await fixture(); cleanups.push(value.cleanup); return value.root; }
const ioFailure = (): Error => Object.assign(new Error('injected failure'), { code: 'EIO' });

describe('publication failure and race boundaries', () => {
  it('keeps the original expected and retired files and cleans temporary files when rename fails', async () => {
    const directory = await root();
    await filesystem.writeFile(join(directory, 'x'), 'original'); await filesystem.writeFile(join(directory, 'old'), 'retired');
    vi.spyOn(filesystem, 'rename').mockRejectedValueOnce(ioFailure());
    const result = await publishGeneratedArtifacts(directory, defineGeneratedArtifactPlan({ artifacts: [{ path: 'x', content: 'new' }], retiredPaths: ['old'] }), options);
    expect(result).toMatchObject({ written: [], removed: [], diagnostics: [{ code: 'GENERATED_ARTIFACT_WRITE_FAILED', path: 'x' }] });
    expect(await filesystem.readFile(join(directory, 'x'), 'utf8')).toBe('original');
    expect(await filesystem.readFile(join(directory, 'old'), 'utf8')).toBe('retired');
    expect((await filesystem.readdir(directory)).sort()).toEqual(['old', 'x']);
  });
  it('does not publish an unflushed temporary file and cleans it after flush failure', async () => {
    const directory = await root(); const originalOpen = filesystem.open;
    vi.spyOn(filesystem, 'open').mockImplementation(async (...args: Parameters<typeof filesystem.open>) => {
      const handle = await originalOpen(...args);
      if (args[1] === 'wx') vi.spyOn(handle, 'sync').mockRejectedValueOnce(ioFailure());
      return handle;
    });
    const result = await publishGeneratedArtifacts(directory, defineGeneratedArtifactPlan({ artifacts: [{ path: 'x', content: 'new' }] }), options);
    expect(result.diagnostics).toMatchObject([{ code: 'GENERATED_ARTIFACT_WRITE_FAILED', path: 'x' }]);
    expect(await filesystem.readdir(directory)).toEqual([]);
  });
  it('wraps read-handle close failures in structured errors', async () => {
    const directory = await root(); await filesystem.writeFile(join(directory, 'x'), 'old');
    const originalOpen = filesystem.open;
    vi.spyOn(filesystem, 'open').mockImplementation(async (...args: Parameters<typeof filesystem.open>) => {
      const handle = await originalOpen(...args); const originalClose = handle.close.bind(handle);
      vi.spyOn(handle, 'close').mockImplementationOnce(async () => { await originalClose(); throw ioFailure(); });
      return handle;
    });
    await expect(inspectGeneratedArtifacts(directory, defineGeneratedArtifactPlan({ artifacts: [{ path: 'x', content: '' }] }), options)).rejects.toMatchObject({ code: 'GENERATED_ARTIFACT_READ_FAILED' });
  });
  it('rejects a target changed into a symlink after preflight and before commit', async () => {
    const directory = await root(); const external = await root();
    await filesystem.writeFile(join(external, 'file'), 'outside');
    const originalOpen = filesystem.open;
    vi.spyOn(filesystem, 'open').mockImplementation(async (...args: Parameters<typeof filesystem.open>) => {
      const handle = await originalOpen(...args);
      if (args[1] === 'wx') { const originalSync = handle.sync.bind(handle); vi.spyOn(handle, 'sync').mockImplementationOnce(async () => { await originalSync(); await filesystem.symlink(join(external, 'file'), join(directory, 'x')); }); }
      return handle;
    });
    const result = await publishGeneratedArtifacts(directory, defineGeneratedArtifactPlan({ artifacts: [{ path: 'x', content: 'new' }] }), options);
    expect(result.diagnostics).toMatchObject([{ code: 'GENERATED_ARTIFACT_SYMLINK_REJECTED', path: 'x' }]);
    expect(await filesystem.readFile(join(external, 'file'), 'utf8')).toBe('outside');
    expect(await filesystem.readdir(directory)).toEqual(['x']);
  });
  it('rejects ancestor replacement before commit and reports cleanup blocked by that symlink', async () => {
    const directory = await root(); const external = await root();
    await filesystem.mkdir(join(directory, 'nested')); await filesystem.writeFile(join(directory, 'old'), 'keep');
    await filesystem.writeFile(join(external, 'x'), 'outside');
    const originalOpen = filesystem.open;
    vi.spyOn(filesystem, 'open').mockImplementation(async (...args: Parameters<typeof filesystem.open>) => {
      const handle = await originalOpen(...args);
      if (args[1] === 'wx') {
        const originalClose = handle.close.bind(handle);
        vi.spyOn(handle, 'close').mockImplementationOnce(async () => { await originalClose(); await filesystem.rename(join(directory, 'nested'), join(directory, 'moved')); await filesystem.symlink(external, join(directory, 'nested'), 'junction'); });
      }
      return handle;
    });
    const result = await publishGeneratedArtifacts(directory, defineGeneratedArtifactPlan({ artifacts: [{ path: 'nested/x', content: 'new' }], retiredPaths: ['old'] }), options);
    expect(result.diagnostics).toMatchObject([{ code: 'GENERATED_ARTIFACT_SYMLINK_REJECTED', path: 'nested/x', details: { cleanupFailed: true } }]);
    expect(result.removed).toEqual([]); expect(await filesystem.readFile(join(directory, 'old'), 'utf8')).toBe('keep');
    expect(await filesystem.readFile(join(external, 'x'), 'utf8')).toBe('outside');
    expect(await filesystem.readdir(external)).toEqual(['x']);
  });
  it('rechecks a retired target changed into a junction after expected writes', async () => {
    const directory = await root(); const external = await root(); const originalRename = filesystem.rename;
    vi.spyOn(filesystem, 'rename').mockImplementationOnce(async (...args: Parameters<typeof filesystem.rename>) => { await originalRename(...args); await filesystem.symlink(external, join(directory, 'old'), 'junction'); });
    const result = await publishGeneratedArtifacts(directory, defineGeneratedArtifactPlan({ artifacts: [{ path: 'x', content: 'new' }], retiredPaths: ['old'] }), options);
    expect(result).toMatchObject({ written: ['x'], removed: [], diagnostics: [{ code: 'GENERATED_ARTIFACT_SYMLINK_REJECTED', path: 'old' }] });
    expect((await filesystem.lstat(join(directory, 'old'))).isSymbolicLink()).toBe(true);
  });
  it('reports failed retired removals and continues other explicit removals deterministically', async () => {
    const directory = await root(); for (const path of ['z', 'a']) await filesystem.writeFile(join(directory, path), 'old');
    const originalUnlink = filesystem.unlink;
    vi.spyOn(filesystem, 'unlink').mockImplementation(async path => { if (path === join(directory, 'a')) throw ioFailure(); await originalUnlink(path); });
    const result = await publishGeneratedArtifacts(directory, defineGeneratedArtifactPlan({ artifacts: [], retiredPaths: ['z', 'a'] }), options);
    expect(result).toMatchObject({ removed: ['z'], diagnostics: [{ code: 'GENERATED_ARTIFACT_REMOVE_FAILED', path: 'a' }] });
    expect(await filesystem.readdir(directory)).toEqual(['a']);
  });
});
