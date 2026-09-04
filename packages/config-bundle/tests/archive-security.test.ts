import { expect, it } from 'vitest';
import { encodeZipArchive, decodeZipArchive } from '@openge/forge-archive-zip';
import { CONFIG_BUNDLE_MANIFEST_PATH, createConfigBundle, decodeConfigBundle } from '../src/index.js';
const createdAt = '2026-09-04T00:00:00Z';
function renamePath(zip: Uint8Array, from: string, to: string): Uint8Array {
    const bytes = Uint8Array.from(zip);
    const a = new TextEncoder().encode(from), b = new TextEncoder().encode(to);
    if (a.length !== b.length)
        throw new Error('fixture size');
    for (let i = 0; i <= bytes.length - a.length; i++)
        if (a.every((value, j) => bytes[i + j] === value))
            bytes.set(b, i);
    return bytes;
}
it.each(['../x', '/abs', 'a\\bc', 'a\0bc', 'C:/a'])('rejects unsafe archived path %s before decoding', async (unsafe) => {
    const zip = encodeZipArchive([{ path: 'safe', kind: 'file', bytes: new Uint8Array([1]) }], { compression: 'store' });
    await expect(decodeConfigBundle(renamePath(zip, 'safe', unsafe))).rejects.toMatchObject({ code: 'CONFIG_BUNDLE_ARCHIVE_UNSAFE' });
});
it('rejects duplicate archived entries', async () => {
    const zip = encodeZipArchive([{ path: 'aaaa', kind: 'file', bytes: new Uint8Array() }, { path: 'bbbb', kind: 'file', bytes: new Uint8Array() }], { compression: 'store' });
    await expect(decodeConfigBundle(renamePath(zip, 'bbbb', 'aaaa'))).rejects.toMatchObject({ code: 'CONFIG_BUNDLE_DUPLICATE_ENTRY' });
});
it('rejects manifest reserved prefix injection', async () => {
    const decoded = decodeZipArchive(await createConfigBundle([], { createdAt }));
    await expect(decodeConfigBundle(encodeZipArchive([...decoded.entries, { kind: 'file', path: '__forge_config_bundle__/injected', bytes: new Uint8Array() }], { compression: 'store' }))).rejects.toMatchObject({ code: 'CONFIG_BUNDLE_RESERVED_PATH' });
});
it.each([{ maxEntries: 1 }, { maxTotalBytes: 1 }, { maxArchiveBytes: 1 }])('bounds archive resources %j', async (limits) => {
    const zip = await createConfigBundle([{ path: 'a', content: new Uint8Array([1]) }, { path: 'b', content: new Uint8Array([2]) }], { createdAt });
    await expect(decodeConfigBundle(zip, { limits })).rejects.toMatchObject({ code: 'CONFIG_BUNDLE_LIMIT_EXCEEDED' });
});
it.each([0, 2, '1'])('rejects archived unsupported schema %s', async (schemaVersion) => {
    const bytes = new TextEncoder().encode(JSON.stringify({ schemaVersion, createdAt, entries: [] }));
    await expect(decodeConfigBundle(encodeZipArchive([{ path: CONFIG_BUNDLE_MANIFEST_PATH, kind: 'file', bytes }], { compression: 'store' }))).rejects.toMatchObject({ code: 'CONFIG_BUNDLE_UNSUPPORTED_SCHEMA_VERSION' });
});
it('rejects malformed UTF-8 manifest', async () => {
    await expect(decodeConfigBundle(encodeZipArchive([{ path: CONFIG_BUNDLE_MANIFEST_PATH, kind: 'file', bytes: new Uint8Array([255]) }], { compression: 'store' }))).rejects.toMatchObject({ code: 'CONFIG_BUNDLE_INVALID_MANIFEST' });
});
