import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createArtifactContentManifest } from '../src/index.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const asset = () => ({ path: 'a.bin', role: 'asset' as const, sha256: hash('a'), byteLength: 1,
  responseHeaders: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-cache' } });
const control = () => ({ path: '_headers', role: 'control' as const, sha256: hash('control'), byteLength: 7 });

describe('versioned content manifest', () => {
  it('binds paths, actual digests, byte lengths, response policy and control files in canonical UTF-8', async () => {
    const prepared = await createArtifactContentManifest({ schemaVersion: 1, files: [asset(), control()] });
    const canonical = JSON.stringify({ schemaVersion: 1, files: [
      { path: '_headers', role: 'control', byteLength: 7, sha256: hash('control') },
      { path: 'a.bin', role: 'asset', byteLength: 1, sha256: hash('a'),
        responseHeaders: { 'cache-control': 'no-cache', 'content-type': 'application/octet-stream' } },
    ] });
    expect(new TextDecoder().decode(prepared.bytes)).toBe(canonical);
    expect(prepared.content.manifestSha256).toBe(hash(canonical));
    const reordered = await createArtifactContentManifest({ schemaVersion: 1, files: [control(), asset()] });
    expect(reordered.content).toEqual(prepared.content);
  });

  it('changes identity for changed payload, path, response policy or control file', async () => {
    const original = await createArtifactContentManifest({ schemaVersion: 1, files: [asset(), control()] });
    for (const files of [[{ ...asset(), sha256: hash('b') }, control()],
      [{ ...asset(), path: 'other.bin' }, control()],
      [{ ...asset(), responseHeaders: { ...asset().responseHeaders, 'Cache-Control': 'no-store' } }, control()],
      [asset(), { ...control(), sha256: hash('changed') }]]) {
      expect((await createArtifactContentManifest({ schemaVersion: 1, files })).content).not.toEqual(original.content);
    }
  });

  it('takes a frozen snapshot before hashing rather than retaining caller metadata', async () => {
    const file = asset(), input = { schemaVersion: 1 as const, files: [file] };
    const pending = createArtifactContentManifest(input);
    file.path = 'changed.bin'; file.responseHeaders['Cache-Control'] = 'no-store'; input.files.length = 0;
    const result = await pending;
    expect(result.manifest.files[0]).toMatchObject({ path: 'a.bin', responseHeaders: { 'cache-control': 'no-cache' } });
    expect(Object.isFrozen(result.manifest.files)).toBe(true);
    expect(Object.isFrozen(result.manifest.files[0])).toBe(true);
  });

  it('rejects unknown own keys even when required fields are inherited', async () => {
    const input = Object.assign(Object.create({ schemaVersion: 1, files: [asset()] }), { ignored: true, other: true });
    await expect(createArtifactContentManifest(input)).rejects.toMatchObject({ code: 'INVALID_PLAN' });
  });

  it('uses deterministic JSON property enumeration for numeric header names', async () => {
    const first = await createArtifactContentManifest({ schemaVersion: 1, files: [{ ...asset(),
      responseHeaders: { ...asset().responseHeaders, '10': 'ten', '2': 'two' } }] });
    const second = await createArtifactContentManifest({ schemaVersion: 1, files: [{ ...asset(),
      responseHeaders: { '2': 'two', '10': 'ten', ...asset().responseHeaders } }] });
    expect(first.content).toEqual(second.content);
    expect(new TextDecoder().decode(first.bytes)).toContain('"responseHeaders":{"2":"two","10":"ten","cache-control":');
  });

  it.each([
    { schemaVersion: 0, files: [asset()] }, { schemaVersion: 1, files: [] },
    { schemaVersion: 1, files: [asset(), asset()] },
    { schemaVersion: 1, files: [{ ...asset(), path: '../escape' }] },
    { schemaVersion: 1, files: [{ ...asset(), byteLength: -1 }] },
    { schemaVersion: 1, files: [{ ...asset(), sha256: 'not-sha256' }] },
    { schemaVersion: 1, files: [{ ...asset(), responseHeaders: { 'Content-Type': 'text/plain\r\nsecret:x' } }] },
    { schemaVersion: 1, files: [{ ...asset(), responseHeaders: { 'Content-Type': 'text/plain', 'content-type': 'other' } }] },
    { schemaVersion: 1, files: [{ ...asset(), responseHeaders: { ...asset().responseHeaders, '\u212A': 'non-ascii-name' } }] },
    { schemaVersion: 1, files: [{ ...control(), responseHeaders: { 'content-type': 'text/plain' } }] },
    { schemaVersion: 1, files: [{ ...asset(), ignoredPolicy: 'must-not-disappear' }] },
    { schemaVersion: 1, files: [{ ...control(), role: { toString: (): string => 'control' } }] },
  ])('rejects malformed or ambiguous manifest data before producing an identity: %j', async input => {
    await expect(Reflect.apply(createArtifactContentManifest, undefined, [input])).rejects.toMatchObject({ code: 'INVALID_PLAN' });
  });
});
