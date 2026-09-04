import { validatePortableRelativePath } from '@openge/forge-path-safety';
import { stringifyDeterministicJson } from '@openge/forge-deterministic-json';
import { DEFAULT_CONFIG_BUNDLE_LIMITS, type ConfigBundleLimits, type ConfigBundleManifestEntry, type ConfigBundleManifestV1 } from './contracts.js';
import { ConfigBundleError } from './errors.js';
export function validateEntryPath(path: string): void {
    try {
        validatePortableRelativePath(path);
        if (path.split('/').some(segment => (/[<>:"|?*]/u.test(segment) || [...segment].some(char => char.charCodeAt(0) < 32)) || /[. ]$/u.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment)))
            throw new Error();
    }
    catch (cause) {
        throw new ConfigBundleError('CONFIG_BUNDLE_INVALID_ENTRY_PATH', { path }, cause);
    }
    if (path.toLowerCase() === '__forge_config_bundle__' || path.toLowerCase().startsWith('__forge_config_bundle__/'))
        throw new ConfigBundleError('CONFIG_BUNDLE_RESERVED_PATH', { path });
}
export function resolveLimits(overrides: Partial<ConfigBundleLimits> = {}): Required<ConfigBundleLimits> {
    const limits = { ...DEFAULT_CONFIG_BUNDLE_LIMITS, ...overrides };
    for (const [key, value] of Object.entries(limits))
        if (!Number.isSafeInteger(value) || value <= 0)
            throw new ConfigBundleError('CONFIG_BUNDLE_LIMIT_EXCEEDED', { limit: key, value });
    return limits;
}
export function validatePaths(paths: readonly string[]): void {
    const seen = new Set<string>();
    for (const path of paths) {
        validateEntryPath(path);
        if (seen.has(path))
            throw new ConfigBundleError('CONFIG_BUNDLE_DUPLICATE_ENTRY', { path });
        seen.add(path);
    }
    for (const path of paths) {
        const parts = path.split('/');
        parts.pop();
        while (parts.length) {
            if (seen.has(parts.join('/')))
                throw new ConfigBundleError('CONFIG_BUNDLE_INVALID_ENTRY_PATH', { path });
            parts.pop();
        }
    }
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
export function parseConfigBundleManifest(value: unknown): ConfigBundleManifestV1 {
    if (!record(value))
        throw new ConfigBundleError('CONFIG_BUNDLE_INVALID_MANIFEST');
    if (value.schemaVersion !== 1)
        throw new ConfigBundleError('CONFIG_BUNDLE_UNSUPPORTED_SCHEMA_VERSION', { schemaVersion: value.schemaVersion });
    const createdAt = value.createdAt;
    if (!validCreatedAt(createdAt) || !Array.isArray(value.entries))
        throw new ConfigBundleError('CONFIG_BUNDLE_INVALID_MANIFEST');
    const entries: ConfigBundleManifestEntry[] = value.entries.map((entry: unknown) => {
        if (!record(entry) || typeof entry.path !== 'string' || typeof entry.byteLength !== 'number' || !Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0 || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.sha256))
            throw new ConfigBundleError('CONFIG_BUNDLE_INVALID_MANIFEST');
        return { path: entry.path, byteLength: entry.byteLength, sha256: entry.sha256 };
    });
    validatePaths(entries.map(e => e.path));
    return { schemaVersion: 1, createdAt, entries: entries.toSorted((a, b) => comparePaths(a.path, b.path)) };
}
export function comparePaths(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
export function encodeManifest(manifest: ConfigBundleManifestV1): Uint8Array { return new TextEncoder().encode(stringifyDeterministicJson(manifest, { trailingNewline: true })); }
function validCreatedAt(value: unknown): value is string {
    if (typeof value !== 'string')
        return false;
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/u.exec(value);
    if (!match || !Number.isFinite(Date.parse(value)))
        return false;
    return new Date(value).toISOString() === match[1] + '.' + (match[2] ?? '').padEnd(3, '0').slice(0, 3) + 'Z';
}
