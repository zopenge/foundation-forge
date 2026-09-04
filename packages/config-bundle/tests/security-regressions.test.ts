import * as fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createConfigBundle, decodeConfigBundle } from '../src/index.js';
import { applyConfigBundleImport, inspectConfigBundleImport } from '../src/node.js';
import { files } from '../src/node/files.js';
let root: string;
const options = { conflictPolicy: 'overwrite', pathCaseSensitivity: 'case-insensitive' } as const;
const bundle = async (entries: Record<string, string>) => decodeConfigBundle(await createConfigBundle(Object.entries(entries).map(([path, content]) => ({ path, content: new TextEncoder().encode(content) })), { createdAt: '2026-09-04T00:00:00Z' }));
beforeEach(async () => { root = await fs.mkdtemp(path.resolve(import.meta.dirname, '../../../.tmp/config-bundle-regression-')); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
it('rejects case aliases in ancestor components before any writes', async () => {
    const b = await bundle({ 'Config/a': 'a', 'config/b': 'b' });
    expect((await inspectConfigBundleImport(root, b, options)).conflicts).toEqual(['Config/a', 'config/b']);
    expect((await applyConfigBundleImport(root, b, options)).diagnostics).toContainEqual(expect.objectContaining({ phase: 'preflight' }));
    expect(await fs.readdir(root)).toEqual([]);
});
it('removes a partially written new backup after backup staging fails', async () => {
    await fs.writeFile(path.join(root, 'a'), 'old');
    const open = files.open;
    vi.spyOn(files, 'open').mockImplementation(async (...args) => { const handle = await open(...args); if (String(args[0]).endsWith(path.join('backup', 'a')) && args[1] === 'wx') {
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async (...input) => { await write(...input); throw new Error('backup disk error'); };
    } return handle; });
    const result = await applyConfigBundleImport(root, await bundle({ a: 'new' }), { ...options, conflictPolicy: 'backup-and-overwrite', backupDirectory: path.join(root, 'backup') });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ phase: 'backup' }));
    expect(await fs.readFile(path.join(root, 'a'), 'utf8')).toBe('old');
    expect(await fs.readdir(root)).toEqual(['a']);
});
it('rejects a backup path alias before writing the original target', async () => {
    await fs.writeFile(path.join(root, 'a'), 'old');
    await fs.mkdir(path.join(root, 'Backup'));
    const result = await applyConfigBundleImport(root, await bundle({ a: 'new' }), { ...options, conflictPolicy: 'backup-and-overwrite', backupDirectory: path.join(root, 'backup') });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ phase: 'preflight' }));
    expect(await fs.readdir(path.join(root, 'Backup'))).toEqual([]);
});
it('includes every owner of a conflicting case-folded ancestor', async () => {
    const b = await bundle({ 'Config/a': 'a', 'config/b': 'b', 'Config/c': 'c' });
    expect((await inspectConfigBundleImport(root, b, options)).conflicts).toEqual(['Config/a', 'Config/c', 'config/b']);
});
it('preserves structured errors for forged missing entry arrays', async () => {
    const b = await bundle({ a: 'new' });
    Object.assign(b, { entries: undefined });
    await expect(inspectConfigBundleImport(root, b, options)).rejects.toMatchObject({ code: 'CONFIG_BUNDLE_INVALID_MANIFEST' });
});
it('detects target replacement after stage close without writing through a junction', async () => {
    await fs.mkdir(path.join(root, 'outside'));
    const open = files.open;
    let swapped = false;
    vi.spyOn(files, 'open').mockImplementation(async (...args) => { const handle = await open(...args); if (args[1] === 'wx' && !swapped) {
        swapped = true;
        const close = handle.close.bind(handle);
        handle.close = async () => { await close(); await fs.symlink(path.join(root, 'outside'), path.join(root, 'a'), 'junction'); };
    } return handle; });
    const result = await applyConfigBundleImport(root, await bundle({ a: 'new' }), options);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ phase: 'commit' }));
    expect(await fs.readdir(path.join(root, 'outside'))).toEqual([]);
});
it('uses a detached copy when the caller changes input during filesystem preflight', async () => {
    const b = await bundle({ a: 'new' });
    const lstat = files.lstat;
    let mutated = false;
    vi.spyOn(files, 'lstat').mockImplementation(async (...args) => { if (!mutated) {
        mutated = true;
        const first = b.entries[0];
        if (first)
            first.content.fill(0);
    } return lstat(...args); });
    const result = await applyConfigBundleImport(root, b, options);
    expect(result.diagnostics).toEqual([]);
    expect(await fs.readFile(path.join(root, 'a'), 'utf8')).toBe('new');
});
it('wraps filesystem read errors in a structured preflight error', async () => {
    vi.spyOn(files, 'lstat').mockRejectedValueOnce(Object.assign(new Error('read denied'), { code: 'EACCES' }));
    await expect(inspectConfigBundleImport(root, await bundle({ a: 'new' }), options)).rejects.toMatchObject({ code: 'CONFIG_BUNDLE_TARGET_UNSAFE' });
});
