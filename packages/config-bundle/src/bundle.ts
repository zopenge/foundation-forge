import { encodeZipArchive, decodeZipArchive, inspectZipArchive, ZipArchiveError } from '@openge/forge-archive-zip';
import { inspectArchiveEntries } from '@openge/forge-archive-safety';
import { calculateBytesIntegrity } from '@openge/forge-artifact-integrity';
import { CONFIG_BUNDLE_MANIFEST_PATH, type ConfigBundleEntry, type ConfigBundleLimits, type CreateConfigBundleOptions, type DecodedConfigBundle } from './contracts.js';
import { ConfigBundleError } from './errors.js';
import { comparePaths, encodeManifest, parseConfigBundleManifest, resolveLimits, validatePaths } from './manifest.js';
const manifestBudget = 1024 * 1024;
function checkEntries(entries: readonly {
    path: string;
    byteLength: number;
}[], limits: Required<ConfigBundleLimits>): void {
    if (entries.length > limits.maxEntries)
        throw new ConfigBundleError('CONFIG_BUNDLE_LIMIT_EXCEEDED', { limit: 'maxEntries' });
    let total = 0;
    for (const entry of entries) {
        total += entry.byteLength;
        if (entry.byteLength > limits.maxEntryBytes || total > limits.maxTotalBytes)
            throw new ConfigBundleError('CONFIG_BUNDLE_LIMIT_EXCEEDED', { path: entry.path });
    }
}
function snapshotEntries(entries: readonly ConfigBundleEntry[], limits: Required<ConfigBundleLimits>): ConfigBundleEntry[] {
    if (!Array.isArray(entries))
        throw new ConfigBundleError('CONFIG_BUNDLE_INVALID_MANIFEST');
    if (entries.length > limits.maxEntries)
        throw new ConfigBundleError('CONFIG_BUNDLE_LIMIT_EXCEEDED', { limit: 'maxEntries' });
    const admitted: ConfigBundleEntry[] = [];
    for (const entry of entries) {
        if (typeof entry !== 'object' || entry === null)
            throw new ConfigBundleError('CONFIG_BUNDLE_INVALID_MANIFEST');
        const { path, content } = entry;
        if (typeof path !== 'string' || !(content instanceof Uint8Array))
            throw new ConfigBundleError('CONFIG_BUNDLE_INVALID_MANIFEST');
        admitted.push({ path, content });
    }
    checkEntries(admitted.map(entry => ({ path: entry.path, byteLength: entry.content.byteLength })), limits);
    validatePaths(admitted.map(entry => entry.path));
    const result = admitted.map(entry => ({ path: entry.path, content: Uint8Array.from(entry.content) }));
    return result.toSorted((a, b) => comparePaths(a.path, b.path));
}
export async function validateDecodedBundle(bundle: DecodedConfigBundle, limits?: Partial<ConfigBundleLimits>): Promise<DecodedConfigBundle> {
    if (typeof bundle !== 'object' || bundle === null)
        throw new ConfigBundleError('CONFIG_BUNDLE_INVALID_MANIFEST');
    const manifest = parseConfigBundleManifest(bundle.manifest);
    const entries = snapshotEntries(bundle.entries, resolveLimits(limits));
    if (entries.length !== manifest.entries.length)
        throw new ConfigBundleError('CONFIG_BUNDLE_ENTRY_SET_MISMATCH');
    for (const [i, entry] of entries.entries()) {
        const expected = manifest.entries[i];
        if (!expected || entry.path !== expected.path)
            throw new ConfigBundleError('CONFIG_BUNDLE_ENTRY_SET_MISMATCH', { path: entry.path });
        if (entry.content.byteLength !== expected.byteLength)
            throw new ConfigBundleError('CONFIG_BUNDLE_SIZE_MISMATCH', { path: entry.path });
        if ((await calculateBytesIntegrity(entry.content)).sha256 !== expected.sha256)
            throw new ConfigBundleError('CONFIG_BUNDLE_DIGEST_MISMATCH', { path: entry.path });
    }
    return { manifest, entries };
}
export async function createConfigBundle(input: readonly ConfigBundleEntry[], options: CreateConfigBundleOptions): Promise<Uint8Array> {
    const limits = resolveLimits(options.limits);
    const entries = snapshotEntries(input, limits);
    const manifest = parseConfigBundleManifest({ schemaVersion: 1, createdAt: options.createdAt, entries: [] });
    const manifestEntries = await Promise.all(entries.map(async (e) => ({ path: e.path, ...await calculateBytesIntegrity(e.content) })));
    const bytes = encodeManifest({ ...manifest, entries: manifestEntries });
    if (bytes.length > manifestBudget)
        throw new ConfigBundleError('CONFIG_BUNDLE_LIMIT_EXCEEDED', { limit: 'manifestBytes' });
    try {
        return encodeZipArchive([...entries.map(e => ({ path: e.path, bytes: e.content, kind: 'file' as const })), { path: CONFIG_BUNDLE_MANIFEST_PATH, bytes, kind: 'file' }], { compression: 'deflate', limits: { maxArchiveBytes: limits.maxArchiveBytes, maxEntries: limits.maxEntries + 1, maxExpandedBytes: limits.maxTotalBytes + manifestBudget } });
    }
    catch (cause) {
        if (cause instanceof ZipArchiveError && cause.code === 'ARCHIVE_TOO_LARGE')
            throw new ConfigBundleError('CONFIG_BUNDLE_LIMIT_EXCEEDED', { limit: 'maxArchiveBytes' }, cause);
        throw new ConfigBundleError('CONFIG_BUNDLE_ARCHIVE_UNSAFE', {}, cause);
    }
}
export async function decodeConfigBundle(input: Uint8Array, options: {
    readonly limits?: Partial<ConfigBundleLimits>;
} = {}): Promise<DecodedConfigBundle> {
    const limits = resolveLimits(options.limits);
    if (!(input instanceof Uint8Array))
        throw new ConfigBundleError('CONFIG_BUNDLE_ARCHIVE_UNSAFE');
    if (input.byteLength > limits.maxArchiveBytes)
        throw new ConfigBundleError('CONFIG_BUNDLE_LIMIT_EXCEEDED', { limit: 'maxArchiveBytes' });
    const archive = Uint8Array.from(input);
    const zipOptions = { limits: { maxArchiveBytes: limits.maxArchiveBytes, maxEntries: limits.maxEntries + 1, maxExpandedBytes: limits.maxTotalBytes + manifestBudget } };
    try {
        const inspection = inspectZipArchive(archive, zipOptions);
        inspectArchiveEntries(inspection.entries, { maxEntries: limits.maxEntries + 1, maxExpandedBytes: limits.maxTotalBytes + manifestBudget });
        if (inspection.entries.some(e => e.kind !== 'file'))
            throw new ConfigBundleError('CONFIG_BUNDLE_ARCHIVE_UNSAFE');
        const meta = inspection.entries.find(e => e.path === CONFIG_BUNDLE_MANIFEST_PATH);
        if (!meta)
            throw new ConfigBundleError('CONFIG_BUNDLE_UNSUPPORTED_LEGACY_FORMAT');
        if (meta.uncompressedBytes > manifestBudget)
            throw new ConfigBundleError('CONFIG_BUNDLE_LIMIT_EXCEEDED', { limit: 'manifestBytes' });
        const business = inspection.entries.filter(e => e.path !== CONFIG_BUNDLE_MANIFEST_PATH);
        validatePaths(business.map(e => e.path));
        checkEntries(business.map(e => ({ path: e.path, byteLength: e.uncompressedBytes })), limits);
        const decoded = decodeZipArchive(archive, zipOptions).entries;
        const manifestEntry = decoded.find(e => e.path === CONFIG_BUNDLE_MANIFEST_PATH);
        if (manifestEntry?.kind !== 'file')
            throw new ConfigBundleError('CONFIG_BUNDLE_INVALID_MANIFEST');
        let value: unknown;
        try {
            value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestEntry.bytes));
        }
        catch (cause) {
            throw new ConfigBundleError('CONFIG_BUNDLE_INVALID_MANIFEST', {}, cause);
        }
        const manifest = parseConfigBundleManifest(value);
        const entries: ConfigBundleEntry[] = decoded.flatMap(e => e.kind === 'file' && e.path !== CONFIG_BUNDLE_MANIFEST_PATH ? [{ path: e.path, content: e.bytes }] : []);
        return await validateDecodedBundle({ manifest, entries }, limits);
    }
    catch (cause) {
        if (cause instanceof ConfigBundleError)
            throw cause;
        if (cause instanceof ZipArchiveError && cause.code === 'DUPLICATE_ENTRY')
            throw new ConfigBundleError('CONFIG_BUNDLE_DUPLICATE_ENTRY', cause.details, cause);
        if (cause instanceof ZipArchiveError && (cause.details.safetyCode === 'ENTRY_LIMIT_EXCEEDED' || cause.details.safetyCode === 'EXPANDED_SIZE_LIMIT_EXCEEDED'))
            throw new ConfigBundleError('CONFIG_BUNDLE_LIMIT_EXCEEDED', {}, cause);
        throw new ConfigBundleError('CONFIG_BUNDLE_ARCHIVE_UNSAFE', {}, cause);
    }
}
