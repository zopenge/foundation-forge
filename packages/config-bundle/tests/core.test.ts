import { describe, expect, it } from 'vitest';
import { encodeZipArchive, decodeZipArchive } from '@openge/forge-archive-zip';
import { createConfigBundle, decodeConfigBundle, parseConfigBundleManifest, CONFIG_BUNDLE_MANIFEST_PATH } from '../src/index.js';
const createdAt = '2026-09-04T00:00:00.000Z';
const entry = { path: 'nested/a.bin', content: new Uint8Array([0, 255, 1]) };
const build = () => createConfigBundle([entry], { createdAt });
async function alter(change: (entries: {
    path: string;
    bytes: Uint8Array;
    kind: 'file';
}[]) => void) {
    const entries = decodeZipArchive(await build()).entries.map(e => { if (e.kind !== 'file')
        throw new Error('fixture'); return { ...e }; });
    change(entries);
    return encodeZipArchive(entries, { compression: 'store' });
}
describe('Manifest V1 and deterministic bundles', () => {
    it('sorts paths and preserves binary data in byte-identical archives', async () => {
        const b = { path: 'b', content: new Uint8Array([2]) };
        expect(await createConfigBundle([entry, b], { createdAt })).toEqual(await createConfigBundle([b, entry], { createdAt }));
        expect((await decodeConfigBundle(await build())).entries).toEqual([entry]);
    });
    it('writes a canonical UTF-8 manifest with one LF and SHA-256', async () => {
        const archive = decodeZipArchive(await createConfigBundle([{ path: 'a', content: new Uint8Array([97]) }], { createdAt }));
        const m = archive.entries.find(e => e.path === CONFIG_BUNDLE_MANIFEST_PATH);
        if (m?.kind !== 'file')
            throw new Error('manifest');
        const raw = new TextDecoder().decode(m.bytes);
        expect(raw.endsWith('}\n')).toBe(true);
        expect(JSON.parse(raw)).toEqual({ schemaVersion: 1, createdAt, entries: [{ path: 'a', byteLength: 1, sha256: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb' }] });
    });
    it.each([0, 2, '1'])('rejects schema %s', schemaVersion => expect(() => parseConfigBundleManifest({ schemaVersion, createdAt, entries: [] })).toThrowError(expect.objectContaining({ code: 'CONFIG_BUNDLE_UNSUPPORTED_SCHEMA_VERSION' })));
    it.each(['2026-02-30T00:00:00.000Z', '2026-09-04', '2026-09-04T00:00:00+00:00'])('rejects invalid UTC timestamp %s', async (value) => await expect(createConfigBundle([], { createdAt: value })).rejects.toMatchObject({ code: 'CONFIG_BUNDLE_INVALID_MANIFEST' }));
    it.each(['../a', '/a', 'C:/a', 'a\\b', 'a\0b', 'a/', 'a:stream', 'CON', 'a.'])('rejects unsafe portable path %s', async (path) => await expect(createConfigBundle([{ ...entry, path }], { createdAt })).rejects.toMatchObject({ code: 'CONFIG_BUNDLE_INVALID_ENTRY_PATH' }));
    it('rejects the reserved prefix', async () => await expect(createConfigBundle([{ ...entry, path: '__forge_config_bundle__/x' }], { createdAt })).rejects.toMatchObject({ code: 'CONFIG_BUNDLE_RESERVED_PATH' }));
    it('rejects duplicate and file-parent collisions', async () => {
        await expect(createConfigBundle([entry, entry], { createdAt })).rejects.toMatchObject({ code: 'CONFIG_BUNDLE_DUPLICATE_ENTRY' });
        await expect(createConfigBundle([{ ...entry, path: 'a' }, { ...entry, path: 'a/b' }], { createdAt })).rejects.toMatchObject({ code: 'CONFIG_BUNDLE_INVALID_ENTRY_PATH' });
    });
    it.each([{ maxEntries: 1 }, { maxEntryBytes: 2 }, { maxTotalBytes: 2 }, { maxArchiveBytes: 1 }])('enforces limits %j', async (limits) => {
        const entries = limits.maxEntries ? [entry, { ...entry, path: 'b' }] : [entry];
        await expect(createConfigBundle(entries, { createdAt, limits })).rejects.toMatchObject({ code: 'CONFIG_BUNDLE_LIMIT_EXCEEDED' });
    });
    it('checks entry limits before inflating', async () => await expect(decodeConfigBundle(await build(), { limits: { maxEntryBytes: 2 } })).rejects.toMatchObject({ code: 'CONFIG_BUNDLE_LIMIT_EXCEEDED' }));
    it('rejects missing and extra entries', async () => {
        for (const action of ['missing', 'extra']) {
            const zip = await alter(entries => { if (action === 'missing')
                entries.splice(entries.findIndex(e => e.path === entry.path), 1);
            else
                entries.push({ path: 'extra', kind: 'file', bytes: new Uint8Array() }); });
            await expect(decodeConfigBundle(zip)).rejects.toMatchObject({ code: 'CONFIG_BUNDLE_ENTRY_SET_MISMATCH' });
        }
    });
    it('rejects tampered digest and size', async () => {
        for (const bytes of [new Uint8Array([3, 4, 5]), new Uint8Array([3])]) {
            const zip = await alter(entries => { const e = entries.find(e => e.path === entry.path); if (e)
                e.bytes = bytes; });
            await expect(decodeConfigBundle(zip)).rejects.toMatchObject({ code: bytes.length === 3 ? 'CONFIG_BUNDLE_DIGEST_MISMATCH' : 'CONFIG_BUNDLE_SIZE_MISMATCH' });
        }
    });
    it('rejects missing manifest as unsupported legacy', async () => await expect(decodeConfigBundle(encodeZipArchive([{ path: 'old', bytes: new Uint8Array(), kind: 'file' }], { compression: 'store' }))).rejects.toMatchObject({ code: 'CONFIG_BUNDLE_UNSUPPORTED_LEGACY_FORMAT' }));
    it('rejects directory entries and malformed archive', async () => {
        await expect(decodeConfigBundle(encodeZipArchive([{ path: 'dir/', kind: 'directory' }], { compression: 'store' }))).rejects.toMatchObject({ code: 'CONFIG_BUNDLE_ARCHIVE_UNSAFE' });
        await expect(decodeConfigBundle(new Uint8Array([1, 2]))).rejects.toMatchObject({ code: 'CONFIG_BUNDLE_ARCHIVE_UNSAFE' });
    });
});
it.each(['2026-09-04T00:00:00.1Z', '2026-09-04T00:00:00.123456Z'])('accepts valid ISO UTC fractional precision %s', async (createdAt) => {
    const decoded = await decodeConfigBundle(await createConfigBundle([], { createdAt }));
    expect(decoded.manifest.createdAt).toBe(createdAt);
});
