import path from 'node:path';
import type { ConfigBundleDiagnostic, ConfigBundleErrorCode, ConfigBundleImportOptions, ConfigBundleImportResult, ConfigBundlePhase, ConfigBundleRollbackFailure, DecodedConfigBundle } from '../contracts.js';
import { ConfigBundleError } from '../errors.js';
import { prepareImport, type PreparedEntry } from './import-plan.js';
import { files } from './files.js';
import { stageFile, writeExclusive } from './backup.js';
import { bytesEqual, isMissing, readSnapshot, recheck, safeDirectories, statOrMissing } from './safe-target.js';
function detail(error: unknown): Readonly<Record<string, unknown>> { return error instanceof ConfigBundleError ? { causeCode: error.code, ...error.details } : typeof error === 'object' && error !== null && 'code' in error ? { systemCode: error.code } : {}; }
export async function applyConfigBundleImport(rootDirectory: string, bundle: DecodedConfigBundle, options: ConfigBundleImportOptions): Promise<ConfigBundleImportResult> {
    const created: string[] = [], unchanged: string[] = [], overwritten: string[] = [], backups: string[] = [], restoredAfterFailure: string[] = [], rollbackFailures: ConfigBundleRollbackFailure[] = [], diagnostics: ConfigBundleDiagnostic[] = [];
    const result = { created, unchanged, overwritten, backups, restoredAfterFailure, rollbackFailures, diagnostics };
    let prepared;
    try {
        prepared = await prepareImport(rootDirectory, bundle, { ...options });
        if (prepared.plan.conflicts.length) {
            diagnostics.push(...prepared.plan.diagnostics.map(d => ({ ...d, phase: 'preflight' as const })));
            return result;
        }
    }
    catch (error) {
        diagnostics.push({ code: error instanceof ConfigBundleError ? error.code : 'CONFIG_BUNDLE_TARGET_UNSAFE', phase: 'preflight', details: detail(error) });
        return result;
    }
    const owned: string[] = [], directories: string[] = [], committed: PreparedEntry[] = [];
    const stages = new Map<string, string>();
    let phase: ConfigBundlePhase = 'staging';
    let activePath: string | undefined;
    try {
        for (const item of prepared.entries) {
            activePath = item.entry.path;
            if (item.plan.action === 'unchanged') {
                unchanged.push(item.entry.path);
                continue;
            }
            await recheck(item.target, item.original);
            stages.set(item.target, await stageFile(item.target, item.entry.content, owned, directories));
        }
        phase = 'backup';
        for (const item of prepared.entries) {
            activePath = item.entry.path;
            if (item.backupTarget && item.original) {
                await recheck(item.target, item.original);
                await writeExclusive(item.backupTarget, item.original.bytes, owned, directories);
                owned.splice(owned.indexOf(item.backupTarget), 1);
                backups.push(item.backupTarget);
            }
        }
        phase = 'commit';
        for (const item of prepared.entries)
            await recheck(item.target, item.original);
        for (const item of prepared.entries) {
            activePath = item.entry.path;
            if (item.plan.action === 'unchanged')
                continue;
            await recheck(item.target, item.original);
            const stage = stages.get(item.target);
            if (!stage)
                throw new ConfigBundleError('CONFIG_BUNDLE_STAGE_FAILED');
            await safeDirectories(path.dirname(stage));
            const staged = await readSnapshot(stage);
            if (!staged || !bytesEqual(staged.bytes, item.entry.content))
                throw new ConfigBundleError('CONFIG_BUNDLE_TARGET_UNSAFE', { path: stage });
            await files.rename(stage, item.target);
            owned.splice(owned.indexOf(stage), 1);
            committed.push(item);
            (item.plan.action === 'create' ? created : overwritten).push(item.entry.path);
        }
    }
    catch (error) {
        const code: ConfigBundleErrorCode = phase === 'staging' ? 'CONFIG_BUNDLE_STAGE_FAILED' : phase === 'backup' ? 'CONFIG_BUNDLE_BACKUP_FAILED' : 'CONFIG_BUNDLE_COMMIT_FAILED';
        diagnostics.push({ code, phase, ...(activePath ? { path: activePath } : {}), details: detail(error) });
        for (const item of committed.reverse()) {
            try {
                const current = await readSnapshot(item.target);
                if (!current || !bytesEqual(current.bytes, item.entry.content))
                    throw new ConfigBundleError('CONFIG_BUNDLE_TARGET_UNSAFE', { path: item.target });
                if (item.original) {
                    const rollback = await stageFile(item.target, item.original.bytes, owned, directories);
                    await recheck(item.target, current);
                    await files.rename(rollback, item.target);
                    owned.splice(owned.indexOf(rollback), 1);
                }
                else {
                    await recheck(item.target, current);
                    await files.unlink(item.target);
                }
                restoredAfterFailure.push(item.entry.path);
            }
            catch (rollbackError) {
                rollbackFailures.push({ path: item.entry.path, code: 'CONFIG_BUNDLE_ROLLBACK_INCOMPLETE', details: detail(rollbackError) });
            }
        }
        if (rollbackFailures.length)
            diagnostics.push({ code: 'CONFIG_BUNDLE_ROLLBACK_INCOMPLETE', phase: 'rollback' });
    }
    finally {
        for (const temporary of owned) {
            try {
                await removeTemporary(temporary);
            }
            catch (error) {
                if (!isMissing(error))
                    diagnostics.push({ code: 'CONFIG_BUNDLE_CLEANUP_FAILED', phase: 'cleanup', path: temporary, details: detail(error) });
            }
        }
        for (const directory of directories.reverse()) {
            try {
                await safeDirectories(directory);
                if ((await files.readdir(directory)).length === 0)
                    await files.rmdir(directory);
            }
            catch (error) {
                if (!isMissing(error))
                    diagnostics.push({ code: 'CONFIG_BUNDLE_CLEANUP_FAILED', phase: 'cleanup', path: directory, details: detail(error) });
            }
        }
    }
    return result;
}
async function removeTemporary(temporary: string): Promise<void> { await safeDirectories(path.dirname(temporary)); const stat = await statOrMissing(temporary); if (stat) {
    if (!stat.isFile() || stat.isSymbolicLink())
        throw new ConfigBundleError('CONFIG_BUNDLE_TARGET_UNSAFE');
    await files.unlink(temporary);
} }
