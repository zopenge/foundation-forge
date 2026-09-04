export interface ConfigBundleManifestEntry {
    readonly path: string;
    readonly byteLength: number;
    readonly sha256: string;
}
export interface ConfigBundleManifestV1 {
    readonly schemaVersion: 1;
    readonly createdAt: string;
    readonly entries: readonly ConfigBundleManifestEntry[];
}
export interface ConfigBundleEntry {
    readonly path: string;
    readonly content: Uint8Array;
}
export interface ConfigBundleLimits {
    readonly maxEntries: number;
    readonly maxEntryBytes: number;
    readonly maxTotalBytes: number;
    readonly maxArchiveBytes?: number;
}
export interface CreateConfigBundleOptions {
    readonly createdAt: string;
    readonly limits?: Partial<ConfigBundleLimits>;
}
export interface DecodedConfigBundle {
    readonly manifest: ConfigBundleManifestV1;
    readonly entries: readonly ConfigBundleEntry[];
}
export const CONFIG_BUNDLE_MANIFEST_PATH = '__forge_config_bundle__/manifest.json';
export const DEFAULT_CONFIG_BUNDLE_LIMITS = Object.freeze({ maxEntries: 256, maxEntryBytes: 4 * 1024 * 1024, maxTotalBytes: 16 * 1024 * 1024, maxArchiveBytes: 20 * 1024 * 1024 });
export type ConfigBundleConflictPolicy = 'reject' | 'overwrite' | 'backup-and-overwrite';
export type ConfigBundlePathCaseSensitivity = 'case-sensitive' | 'case-insensitive';
export interface ConfigBundleImportOptions {
    readonly conflictPolicy: ConfigBundleConflictPolicy;
    readonly pathCaseSensitivity: ConfigBundlePathCaseSensitivity;
    readonly backupDirectory?: string;
}
export interface ConfigBundleImportEntryPlan {
    readonly path: string;
    readonly action: 'create' | 'unchanged' | 'overwrite';
    readonly backupPath?: string;
}
export type ConfigBundlePhase = 'preflight' | 'staging' | 'backup' | 'commit' | 'rollback' | 'cleanup';
export type ConfigBundleErrorCode = 'CONFIG_BUNDLE_INVALID_ENTRY_PATH' | 'CONFIG_BUNDLE_RESERVED_PATH' | 'CONFIG_BUNDLE_DUPLICATE_ENTRY' | 'CONFIG_BUNDLE_LIMIT_EXCEEDED' | 'CONFIG_BUNDLE_INVALID_MANIFEST' | 'CONFIG_BUNDLE_UNSUPPORTED_SCHEMA_VERSION' | 'CONFIG_BUNDLE_UNSUPPORTED_LEGACY_FORMAT' | 'CONFIG_BUNDLE_ENTRY_SET_MISMATCH' | 'CONFIG_BUNDLE_DIGEST_MISMATCH' | 'CONFIG_BUNDLE_SIZE_MISMATCH' | 'CONFIG_BUNDLE_ARCHIVE_UNSAFE' | 'CONFIG_BUNDLE_ROOT_NOT_ABSOLUTE' | 'CONFIG_BUNDLE_BACKUP_ROOT_REQUIRED' | 'CONFIG_BUNDLE_TARGET_OUTSIDE_ROOT' | 'CONFIG_BUNDLE_TARGET_UNSAFE' | 'CONFIG_BUNDLE_CONFLICT' | 'CONFIG_BUNDLE_STAGE_FAILED' | 'CONFIG_BUNDLE_BACKUP_FAILED' | 'CONFIG_BUNDLE_COMMIT_FAILED' | 'CONFIG_BUNDLE_ROLLBACK_INCOMPLETE' | 'CONFIG_BUNDLE_INVALID_OPTIONS' | 'CONFIG_BUNDLE_CLEANUP_FAILED';
export interface ConfigBundleDiagnostic {
    readonly code: ConfigBundleErrorCode;
    readonly phase?: ConfigBundlePhase;
    readonly path?: string;
    readonly details?: Readonly<Record<string, unknown>>;
}
export interface ConfigBundleImportPlan {
    readonly entries: readonly ConfigBundleImportEntryPlan[];
    readonly conflicts: readonly string[];
    readonly diagnostics: readonly ConfigBundleDiagnostic[];
}
export interface ConfigBundleRollbackFailure {
    readonly path: string;
    readonly code: 'CONFIG_BUNDLE_ROLLBACK_INCOMPLETE';
    readonly details?: Readonly<Record<string, unknown>>;
}
export interface ConfigBundleImportResult {
    readonly created: readonly string[];
    readonly unchanged: readonly string[];
    readonly overwritten: readonly string[];
    readonly backups: readonly string[];
    readonly restoredAfterFailure: readonly string[];
    readonly rollbackFailures: readonly ConfigBundleRollbackFailure[];
    readonly diagnostics: readonly ConfigBundleDiagnostic[];
}
