import * as fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfigBundle, decodeConfigBundle } from '../src/index.js';
import { inspectConfigBundleImport, applyConfigBundleImport } from '../src/node.js';
import { files } from '../src/node/files.js';
let root: string;
const options = { conflictPolicy: 'overwrite', pathCaseSensitivity: 'case-sensitive' } as const;
async function bundle(entries: Record<string, string | Uint8Array>) { return decodeConfigBundle(await createConfigBundle(Object.entries(entries).map(([path, content]) => ({ path, content: typeof content === 'string' ? new TextEncoder().encode(content) : content })), { createdAt: '2026-09-04T00:00:00Z' })); }
beforeEach(async () => { const parent = path.resolve(import.meta.dirname, '../../../.tmp'); await fs.mkdir(parent, { recursive: true }); root = await fs.mkdtemp(path.join(parent, 'config-bundle-')); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
describe('safe import planning', () => {
    it('classifies all entries and aggregates reject conflicts without writes', async () => {
        await fs.writeFile(path.join(root, 'a'), 'old');
        await fs.writeFile(path.join(root, 'b'), 'same');
        await fs.writeFile(path.join(root, 'c'), 'old');
        const b = await bundle({ a: 'new', b: 'same', c: 'new', d: 'new' });
        const plan = await inspectConfigBundleImport(root, b, { ...options, conflictPolicy: 'reject' });
        expect(plan.entries.map(e => [e.path, e.action])).toEqual([['a', 'overwrite'], ['b', 'unchanged'], ['c', 'overwrite'], ['d', 'create']]);
        expect(plan.conflicts).toEqual(['a', 'c']);
        const result = await applyConfigBundleImport(root, b, { ...options, conflictPolicy: 'reject' });
        expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'CONFIG_BUNDLE_CONFLICT', phase: 'preflight' }));
        expect(await fs.readFile(path.join(root, 'a'), 'utf8')).toBe('old');
        expect(await fs.readdir(root)).toEqual(['a', 'b', 'c']);
    });
    it('requires explicit absolute roots, policy and case choice', async () => {
        const b = await bundle({ a: 'new' });
        await expect(inspectConfigBundleImport('relative', b, options)).rejects.toMatchObject({ code: 'CONFIG_BUNDLE_ROOT_NOT_ABSOLUTE' });
        await expect(inspectConfigBundleImport(root, b, { ...options, conflictPolicy: 'backup-and-overwrite' })).rejects.toMatchObject({ code: 'CONFIG_BUNDLE_BACKUP_ROOT_REQUIRED' });
        await expect(inspectConfigBundleImport(root, b, { ...options, pathCaseSensitivity: 'wrong' as 'case-sensitive' })).rejects.toMatchObject({ code: 'CONFIG_BUNDLE_INVALID_OPTIONS' });
    });
    it('allows separated backup directory inside root with stable relative paths', async () => {
        await fs.mkdir(path.join(root, 'config/local'), { recursive: true });
        await fs.writeFile(path.join(root, 'config/local/a'), 'old');
        const plan = await inspectConfigBundleImport(root, await bundle({ 'config/local/a': 'new' }), { ...options, conflictPolicy: 'backup-and-overwrite', backupDirectory: path.join(root, 'config/backups/run') });
        expect(plan.entries).toEqual([{ path: 'config/local/a', action: 'overwrite', backupPath: 'config/local/a' }]);
    });
    it('rejects backup overlap and existing backups', async () => {
        await fs.writeFile(path.join(root, 'a'), 'old');
        await expect(inspectConfigBundleImport(root, await bundle({ a: 'new' }), { ...options, conflictPolicy: 'backup-and-overwrite', backupDirectory: root })).rejects.toMatchObject({ code: 'CONFIG_BUNDLE_TARGET_UNSAFE' });
        await fs.mkdir(path.join(root, 'backups'));
        await fs.writeFile(path.join(root, 'backups/a'), 'keep');
        await expect(inspectConfigBundleImport(root, await bundle({ a: 'new' }), { ...options, conflictPolicy: 'backup-and-overwrite', backupDirectory: path.join(root, 'backups') })).rejects.toMatchObject({ code: 'CONFIG_BUNDLE_BACKUP_FAILED' });
    });
    it('aggregates case aliases only under explicit insensitive policy', async () => {
        const b = await bundle({ a: 'one', A: 'two' });
        expect((await inspectConfigBundleImport(root, b, { ...options, pathCaseSensitivity: 'case-insensitive' })).conflicts).toEqual(['A', 'a']);
        expect((await inspectConfigBundleImport(root, b, options)).conflicts).toEqual([]);
    });
    it('detects on-disk aliases in insensitive mode', async () => {
        await fs.writeFile(path.join(root, 'Name'), 'old');
        expect((await inspectConfigBundleImport(root, await bundle({ name: 'new' }), { ...options, pathCaseSensitivity: 'case-insensitive' })).conflicts).toEqual(['name']);
    });
    it('rejects root, ancestor and target junctions and directories', async () => {
        await fs.mkdir(path.join(root, 'real'));
        await fs.symlink(path.join(root, 'real'), path.join(root, 'link'), 'junction');
        for (const target of [path.join(root, 'link'), path.join(root, 'link/sub')])
            await expect(inspectConfigBundleImport(target, await bundle({ a: 'new' }), options)).rejects.toMatchObject({ code: 'CONFIG_BUNDLE_TARGET_UNSAFE' });
        await expect(inspectConfigBundleImport(root, await bundle({ 'link/a': 'new' }), options)).rejects.toMatchObject({ code: 'CONFIG_BUNDLE_TARGET_UNSAFE' });
        await expect(inspectConfigBundleImport(root, await bundle({ real: 'new' }), options)).rejects.toMatchObject({ code: 'CONFIG_BUNDLE_TARGET_UNSAFE' });
    });
    it('revalidates forged and modified decoded input', async () => {
        const b = await bundle({ a: 'new' });
        const first = b.entries[0];
        if (!first)
            throw new Error('fixture');
        first.content[0] = 0;
        await expect(inspectConfigBundleImport(root, b, options)).rejects.toMatchObject({ code: 'CONFIG_BUNDLE_DIGEST_MISMATCH' });
        const result = await applyConfigBundleImport(root, b, options);
        expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'CONFIG_BUNDLE_DIGEST_MISMATCH', phase: 'preflight' }));
        expect(await fs.readdir(root)).toEqual([]);
    });
});
describe('staged atomic publication and rollback', () => {
    it('creates binary, preserves unchanged mtime and writes usable backups', async () => {
        await fs.mkdir(path.join(root, 'config/local'), { recursive: true });
        await fs.writeFile(path.join(root, 'config/local/a'), 'old');
        await fs.writeFile(path.join(root, 'same'), 'same');
        const before = (await fs.stat(path.join(root, 'same'))).mtimeMs;
        const result = await applyConfigBundleImport(root, await bundle({ 'config/local/a': 'new', same: 'same', bytes: new Uint8Array([0, 255]) }), { ...options, conflictPolicy: 'backup-and-overwrite', backupDirectory: path.join(root, 'config/backups/run') });
        expect(result.created).toEqual(['bytes']);
        expect(result.overwritten).toEqual(['config/local/a']);
        expect(result.unchanged).toEqual(['same']);
        expect(result.diagnostics).toEqual([]);
        expect(await fs.readFile(path.join(root, 'bytes'))).toEqual(Buffer.from([0, 255]));
        expect((await fs.stat(path.join(root, 'same'))).mtimeMs).toBe(before);
        expect(await fs.readFile(path.join(root, 'config/backups/run/config/local/a'), 'utf8')).toBe('old');
    });
    it('cleans all stages and newly created directories after staging failure', async () => {
        const open = files.open;
        let writes = 0;
        vi.spyOn(files, 'open').mockImplementation(async (...args) => { if (args[1] === 'wx' && ++writes === 2)
            throw new Error('stage failure'); return open(...args); });
        const result = await applyConfigBundleImport(root, await bundle({ 'x/a': 'a', 'y/b': 'b' }), options);
        expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'CONFIG_BUNDLE_STAGE_FAILED', phase: 'staging' }));
        expect(await fs.readdir(root)).toEqual([]);
    });
    it('restores overwritten and deletes created files after a later commit fails', async () => {
        await fs.writeFile(path.join(root, 'a'), 'old');
        const rename = files.rename;
        let commits = 0;
        vi.spyOn(files, 'rename').mockImplementation(async (...args) => { if (++commits === 3)
            throw new Error('commit failure'); return rename(...args); });
        const result = await applyConfigBundleImport(root, await bundle({ a: 'new', b: 'new', c: 'new' }), options);
        expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'CONFIG_BUNDLE_COMMIT_FAILED', phase: 'commit' }));
        expect(result.restoredAfterFailure).toEqual(['b', 'a']);
        expect(result.rollbackFailures).toEqual([]);
        expect(await fs.readFile(path.join(root, 'a'), 'utf8')).toBe('old');
        expect(await fs.readdir(root)).toEqual(['a']);
    });
    it('reports each rollback failure', async () => {
        await fs.writeFile(path.join(root, 'a'), 'old');
        const rename = files.rename;
        let commits = 0;
        vi.spyOn(files, 'rename').mockImplementation(async (...args) => { if (++commits >= 2)
            throw new Error('commit and rollback failure'); return rename(...args); });
        const result = await applyConfigBundleImport(root, await bundle({ a: 'new', b: 'new' }), options);
        expect(result.rollbackFailures).toEqual([expect.objectContaining({ path: 'a', code: 'CONFIG_BUNDLE_ROLLBACK_INCOMPLETE' })]);
        expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'CONFIG_BUNDLE_ROLLBACK_INCOMPLETE', phase: 'rollback' }));
    });
    it('detects real ancestor replacement between staging and commit', async () => {
        await fs.mkdir(path.join(root, 'target'));
        await fs.mkdir(path.join(root, 'outside'));
        const open = files.open;
        let replaced = false;
        vi.spyOn(files, 'open').mockImplementation(async (...args) => { const handle = await open(...args); if (args[1] === 'wx' && !replaced) {
            replaced = true;
            const close = handle.close.bind(handle);
            handle.close = async () => { await close(); await fs.rename(path.join(root, 'target'), path.join(root, 'moved')); await fs.symlink(path.join(root, 'outside'), path.join(root, 'target'), 'junction'); };
        } return handle; });
        const result = await applyConfigBundleImport(root, await bundle({ 'target/a': 'new' }), options);
        expect(result.diagnostics.length).toBeGreaterThan(0);
        expect(await fs.readdir(path.join(root, 'outside'))).toEqual([]);
    });
    it('does not overwrite a racing backup file', async () => {
        await fs.writeFile(path.join(root, 'a'), 'old');
        const open = files.open;
        let stages = 0;
        vi.spyOn(files, 'open').mockImplementation(async (...args) => { if (args[1] === 'wx' && ++stages === 2) {
            await fs.writeFile(String(args[0]), 'keep');
        } return open(...args); });
        const result = await applyConfigBundleImport(root, await bundle({ a: 'new' }), { ...options, conflictPolicy: 'backup-and-overwrite', backupDirectory: path.join(root, 'backup') });
        expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'CONFIG_BUNDLE_BACKUP_FAILED', phase: 'backup' }));
        expect(await fs.readFile(path.join(root, 'a'), 'utf8')).toBe('old');
        expect(await fs.readFile(path.join(root, 'backup/a'), 'utf8')).toBe('keep');
    });
});
