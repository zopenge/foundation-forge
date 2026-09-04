import { afterEach, expect, it, vi } from 'vitest';
import { createConfigBundle, decodeConfigBundle, type ConfigBundleEntry, type DecodedConfigBundle } from '../src/index.js';
import { validateDecodedBundle } from '../src/bundle.js';
import { applyConfigBundleImport } from '../src/node.js';
const createdAt = '2026-09-04T00:00:00Z';
afterEach(() => vi.restoreAllMocks());

it.each([undefined, { maxArchiveBytes: 8 }])('rejects oversized archives before allocating a defensive copy (%j)', async limits => {
    const input = new Uint8Array((limits?.maxArchiveBytes ?? 20 * 1024 * 1024) + 1);
    const copies = vi.spyOn(Uint8Array, 'from');
    await expect(decodeConfigBundle(input, limits ? { limits } : {})).rejects.toMatchObject({ code: 'CONFIG_BUNDLE_LIMIT_EXCEEDED' });
    expect(copies.mock.calls.length).toBe(0);
});

it.each([
    { limits: { maxEntries: 1 }, entries: [{ path: 'a', content: new Uint8Array([1]) }, { path: 'b', content: new Uint8Array([2]) }] },
    { limits: { maxEntryBytes: 1 }, entries: [{ path: 'a', content: new Uint8Array([1]) }, { path: 'b', content: new Uint8Array([2, 3]) }] },
    { limits: { maxTotalBytes: 2 }, entries: [{ path: 'a', content: new Uint8Array([1]) }, { path: 'b', content: new Uint8Array([2, 3]) }] },
])('validates every create input limit before copying the first entry (%j)', async ({ limits, entries }) => {
    const copies = vi.spyOn(Uint8Array, 'from');
    await expect(createConfigBundle(entries, { createdAt, limits })).rejects.toMatchObject({ code: 'CONFIG_BUNDLE_LIMIT_EXCEEDED' });
    expect(copies.mock.calls.length).toBe(0);
});

it('checks the whole entry shape before copying earlier valid entries', async () => {
    const valid = { path: 'a', content: new Uint8Array([1]) };
    const invalid: ConfigBundleEntry = Object.assign({ path: 'b', content: new Uint8Array() }, { content: undefined });
    const copies = vi.spyOn(Uint8Array, 'from');
    await expect(createConfigBundle([valid, invalid], { createdAt })).rejects.toMatchObject({ code: 'CONFIG_BUNDLE_INVALID_MANIFEST' });
    expect(copies.mock.calls.length).toBe(0);
});

it('rejects the default decoded entry limit before Node apply can copy or touch disk', async () => {
    const forged: DecodedConfigBundle = {
        manifest: { schemaVersion: 1, createdAt, entries: [] },
        entries: [{ path: 'a', content: new Uint8Array(4 * 1024 * 1024 + 1) }],
    };
    const copies = vi.spyOn(Uint8Array, 'from');
    await expect(validateDecodedBundle(forged)).rejects.toMatchObject({ code: 'CONFIG_BUNDLE_LIMIT_EXCEEDED' });
    const result = await applyConfigBundleImport(import.meta.dirname, forged, { conflictPolicy: 'overwrite', pathCaseSensitivity: 'case-sensitive' });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'CONFIG_BUNDLE_LIMIT_EXCEEDED', phase: 'preflight' }));
    expect(copies.mock.calls.length).toBe(0);
});

it('keeps caller-provided limits and defensive copies for admitted entries', async () => {
    const content = new Uint8Array([97, 98, 99]);
    const pending = createConfigBundle([{ path: 'a', content }], { createdAt, limits: { maxEntries: 1, maxEntryBytes: 3, maxTotalBytes: 3 } });
    content.fill(0);
    const archive = await pending;
    const decoded = await decodeConfigBundle(archive, { limits: { maxEntries: 1, maxEntryBytes: 3, maxTotalBytes: 3, maxArchiveBytes: archive.length } });
    expect(decoded.entries[0]?.content).toEqual(new Uint8Array([97, 98, 99]));
});

it('rejects a forged archive shape before copying it', async () => {
    const malformed = { byteLength: 0 } as Uint8Array;
    const copies = vi.spyOn(Uint8Array, 'from');
    await expect(decodeConfigBundle(malformed)).rejects.toMatchObject({ code: 'CONFIG_BUNDLE_ARCHIVE_UNSAFE' });
    expect(copies.mock.calls.length).toBe(0);
});
