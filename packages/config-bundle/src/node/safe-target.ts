import path from 'node:path';
import { constants, type Stats } from 'node:fs';
import { ConfigBundleError } from '../errors.js';
import { files } from './files.js';
export function isMissing(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'; }
export function absoluteRoot(root: string): string { if (!path.isAbsolute(root))
    throw new ConfigBundleError('CONFIG_BUNDLE_ROOT_NOT_ABSOLUTE', { path: root }); return path.resolve(root); }
export function targetPath(root: string, relative: string): string { const target = path.resolve(root, ...relative.split('/')); if (!target.startsWith(root.endsWith(path.sep) ? root : root + path.sep))
    throw new ConfigBundleError('CONFIG_BUNDLE_TARGET_OUTSIDE_ROOT', { path: relative }); return target; }
export async function statOrMissing(target: string): Promise<Stats | undefined> { try {
    return await files.lstat(target);
}
catch (error) {
    if (isMissing(error))
        return;
    throw error;
} }
export async function safeDirectories(directory: string): Promise<void> {
    const parts: string[] = [];
    let current = directory;
    while (true) {
        parts.push(current);
        const parent = path.dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
    for (const item of parts.reverse()) {
        const stat = await statOrMissing(item);
        if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
            throw new ConfigBundleError('CONFIG_BUNDLE_TARGET_UNSAFE', { path: item });
    }
}
export async function ensureDirectories(directory: string, created: string[]): Promise<void> {
    await safeDirectories(directory);
    const missing: string[] = [];
    let current = directory;
    while (!(await statOrMissing(current))) {
        missing.push(current);
        current = path.dirname(current);
    }
    for (const item of missing.reverse()) {
        await safeDirectories(path.dirname(item));
        await files.mkdir(item);
        created.push(item);
        await safeDirectories(item);
    }
}
export interface Snapshot {
    readonly bytes: Uint8Array;
    readonly dev: number;
    readonly ino: number;
    readonly mtimeMs: number;
}
export async function readSnapshot(target: string): Promise<Snapshot | undefined> {
    await safeDirectories(path.dirname(target));
    const stat = await statOrMissing(target);
    if (!stat)
        return;
    if (!stat.isFile() || stat.isSymbolicLink())
        throw new ConfigBundleError('CONFIG_BUNDLE_TARGET_UNSAFE', { path: target });
    const handle = await files.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino)
            throw new ConfigBundleError('CONFIG_BUNDLE_TARGET_UNSAFE', { path: target });
        const bytes = Uint8Array.from(await handle.readFile());
        const after = await handle.stat();
        if (after.mtimeMs !== opened.mtimeMs || after.size !== opened.size)
            throw new ConfigBundleError('CONFIG_BUNDLE_CONFLICT', { path: target });
        await safeDirectories(path.dirname(target));
        const live = await statOrMissing(target);
        if (!live || live.isSymbolicLink() || live.dev !== opened.dev || live.ino !== opened.ino)
            throw new ConfigBundleError('CONFIG_BUNDLE_TARGET_UNSAFE', { path: target });
        return { bytes, dev: opened.dev, ino: opened.ino, mtimeMs: opened.mtimeMs };
    }
    finally {
        await handle.close();
    }
}
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean { return a.length === b.length && a.every((v, i) => v === b[i]); }
export async function recheck(target: string, expected: Snapshot | undefined): Promise<void> {
    const current = await readSnapshot(target);
    if (current === undefined && expected === undefined)
        return;
    if (!current || !expected || current.dev !== expected.dev || current.ino !== expected.ino || current.mtimeMs !== expected.mtimeMs || !bytesEqual(current.bytes, expected.bytes))
        throw new ConfigBundleError('CONFIG_BUNDLE_CONFLICT', { path: target });
}
export async function caseAlias(target: string): Promise<boolean> {
    const parts: string[] = [];
    let current = target;
    while (path.dirname(current) !== current) {
        parts.push(path.basename(current));
        current = path.dirname(current);
    }
    for (const part of parts.reverse()) {
        const stat = await statOrMissing(current);
        if (!stat)
            return false;
        const names = await files.readdir(current);
        const matching = names.filter(n => n.toLowerCase() === part.toLowerCase());
        if (matching.some(n => n !== part))
            return true;
        current = path.join(current, part);
    }
    return false;
}
