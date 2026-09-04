import path from 'node:path';
import type { ConfigBundleDiagnostic, ConfigBundleEntry, ConfigBundleImportEntryPlan, ConfigBundleImportOptions, ConfigBundleImportPlan, DecodedConfigBundle } from '../contracts.js';
import { validateDecodedBundle } from '../bundle.js';
import { ConfigBundleError } from '../errors.js';
import { comparePaths } from '../manifest.js';
import { absoluteRoot, bytesEqual, caseAlias, readSnapshot, safeDirectories, statOrMissing, targetPath, type Snapshot } from './safe-target.js';
export interface PreparedEntry {
    readonly entry: ConfigBundleEntry;
    readonly target: string;
    readonly original: Snapshot | undefined;
    readonly plan: ConfigBundleImportEntryPlan;
    readonly backupTarget?: string;
}
export interface PreparedImport {
    readonly entries: PreparedEntry[];
    readonly plan: ConfigBundleImportPlan;
}
function overlaps(a: string, b: string, insensitive: boolean): boolean { const x = insensitive ? a.toLowerCase() : a; const y = insensitive ? b.toLowerCase() : b; return x === y || x.startsWith(y + path.sep) || y.startsWith(x + path.sep); }
export async function prepareImport(rootDirectory: string, input: DecodedConfigBundle, options: ConfigBundleImportOptions): Promise<PreparedImport> {
    const root = absoluteRoot(rootDirectory);
    if (!['reject', 'overwrite', 'backup-and-overwrite'].includes(options.conflictPolicy) || !['case-sensitive', 'case-insensitive'].includes(options.pathCaseSensitivity))
        throw new ConfigBundleError('CONFIG_BUNDLE_INVALID_OPTIONS');
    const backup = options.conflictPolicy === 'backup-and-overwrite' ? options.backupDirectory : undefined;
    if (options.conflictPolicy === 'backup-and-overwrite' && !backup)
        throw new ConfigBundleError('CONFIG_BUNDLE_BACKUP_ROOT_REQUIRED');
    const backupRoot = backup === undefined ? undefined : absoluteRoot(backup);
    const bundle = await validateDecodedBundle(input);
    await safeDirectories(root);
    if (backupRoot)
        await safeDirectories(backupRoot);
    const entries: PreparedEntry[] = [];
    const conflicts = new Set<string>();
    const diagnostics: ConfigBundleDiagnostic[] = [];
    const insensitive = options.pathCaseSensitivity === 'case-insensitive';
    const aliases = new Set<string>();
    if (insensitive) {
        const prefixes = new Map<string, {
            spelling: string;
            owners: Set<string>;
        }>();
        for (const entry of bundle.entries) {
            let prefix = '';
            for (const segment of entry.path.split('/')) {
                prefix = prefix ? prefix + '/' + segment : segment;
                const key = prefix.toLowerCase();
                const known = prefixes.get(key);
                if (known) {
                    known.owners.add(entry.path);
                    if (known.spelling !== prefix) {
                        for (const owner of known.owners)
                            aliases.add(owner);
                    }
                }
                else
                    prefixes.set(key, { spelling: prefix, owners: new Set([entry.path]) });
            }
        }
        for (const a of bundle.entries)
            for (const b of bundle.entries)
                if (a.path !== b.path && overlaps(a.path.replaceAll('/', path.sep), b.path.replaceAll('/', path.sep), true)) {
                    aliases.add(a.path);
                    aliases.add(b.path);
                }
    }
    const targets = bundle.entries.map(e => targetPath(root, e.path));
    if (backupRoot) {
        if (root === backupRoot || targets.some(t => backupRoot === t || backupRoot.startsWith(t + path.sep)))
            throw new ConfigBundleError('CONFIG_BUNDLE_TARGET_UNSAFE', { path: backupRoot });
        for (const e of bundle.entries) {
            const b = targetPath(backupRoot, e.path);
            if (targets.some(t => overlaps(t, b, insensitive)))
                throw new ConfigBundleError('CONFIG_BUNDLE_TARGET_UNSAFE', { path: b });
        }
    }
    for (const entry of bundle.entries) {
        const target = targetPath(root, entry.path);
        const original = await readSnapshot(target);
        if (insensitive && await caseAlias(target))
            aliases.add(entry.path);
        const action = original === undefined ? 'create' : bytesEqual(original.bytes, entry.content) ? 'unchanged' : 'overwrite';
        if (action === 'overwrite' && options.conflictPolicy === 'reject')
            conflicts.add(entry.path);
        const backupTarget = backupRoot && action === 'overwrite' ? targetPath(backupRoot, entry.path) : undefined;
        if (backupTarget) {
            if (insensitive && await caseAlias(backupTarget))
                throw new ConfigBundleError('CONFIG_BUNDLE_CONFLICT', { path: entry.path, reason: 'backup-case-alias' });
            await safeDirectories(path.dirname(backupTarget));
            if (await statOrMissing(backupTarget))
                throw new ConfigBundleError('CONFIG_BUNDLE_BACKUP_FAILED', { path: entry.path, reason: 'already-exists' });
        }
        const plan: ConfigBundleImportEntryPlan = { path: entry.path, action, ...(backupTarget ? { backupPath: entry.path } : {}) };
        entries.push({ entry, target, original, plan, ...(backupTarget ? { backupTarget } : {}) });
    }
    for (const alias of aliases) {
        conflicts.add(alias);
        diagnostics.push({ code: 'CONFIG_BUNDLE_CONFLICT', path: alias, details: { reason: 'case-alias' } });
    }
    for (const conflict of conflicts)
        if (!aliases.has(conflict))
            diagnostics.push({ code: 'CONFIG_BUNDLE_CONFLICT', path: conflict });
    return { entries, plan: { entries: entries.map(e => e.plan), conflicts: [...conflicts].sort(comparePaths), diagnostics } };
}
export async function inspectConfigBundleImport(rootDirectory: string, bundle: DecodedConfigBundle, options: ConfigBundleImportOptions): Promise<ConfigBundleImportPlan> { try {
    return (await prepareImport(rootDirectory, bundle, { ...options })).plan;
}
catch (cause) {
    if (cause instanceof ConfigBundleError)
        throw cause;
    throw new ConfigBundleError('CONFIG_BUNDLE_TARGET_UNSAFE', {}, cause);
} }
