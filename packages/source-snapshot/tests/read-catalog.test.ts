import { expect, test, vi } from 'vitest';
import { buildSourceTextPackage, createTextSnapshotManifest, stageSourceTextFile } from '../src/index.js';
import type * as Catalog from '../src/read-catalog.js';
import type { ReadCatalogBundle } from '../src/read-catalog-contracts.js';
const utf8 = (text: string) => new TextEncoder().encode(text);
const load = async (): Promise<typeof Catalog> => {
  const module = await vi.importActual<typeof Catalog>('../src/read-catalog.js').catch(() => undefined);
  expect(module, 'SS2-02 catalog implementation is required').toBeDefined();
  if (!module) throw new Error('missing catalog implementation');
  return module;
};
async function fixture(count = 6) {
  const files = Array.from({ length: count }, (_, i) => ({
    path: i === 0 ? 'src/中文 空格🙂.ts' : `src/module-${i}/same.ts`, group: 'code',
    bytes: utf8(i < 2 ? 'shared\r\nbody\n' : `line ${i}\n${'x'.repeat(i === 2 ? 12000 : 12)}\n`),
  }));
  const textPackage = await buildSourceTextPackage(await Promise.all(files.map(stageSourceTextFile)), {
    targetObjectBytes: 2048, maxObjectBytes: 4096, maxObjectCount: 10000,
    maxObjectBytesTotal: 100_000_000, textFormatVersion: 2,
  });
  const manifest = await createTextSnapshotManifest({ projectId: 'catalog-fixture', policyVersion: 'v2', publishedAt: 1, repositories: [], textPackage });
  return { manifest, textPackage };
}
const assertBudgets = (bundle: ReadCatalogBundle, leafBytes = 262144) => {
  expect(bundle.root.byteLength).toBeLessThanOrEqual(65536);
  for (const item of bundle.artifacts) expect(utf8(item.content).byteLength).toBe(item.byteLength);
  for (const item of bundle.artifacts.filter(a => a.path.startsWith('shards/'))) expect(item.byteLength).toBeLessThanOrEqual(leafBytes);
};
test('builds deterministic bounded catalogs without rewriting source objects', async () => {
  const api = await load(); const { manifest, textPackage } = await fixture(300);
  const before = JSON.stringify({ manifest, textPackage });
  const first = await api.buildSnapshotReadCatalog(manifest);
  expect(await api.buildSnapshotReadCatalog(manifest)).toEqual(first);
  expect(JSON.stringify({ manifest, textPackage })).toBe(before);
  assertBudgets(first);
  expect(first.artifacts.length).toBeLessThan(100);
  expect(first.artifacts.reduce((sum, a) => sum + a.byteLength, 0)).toBe(first.totalBytes);
  expect(first.root.content).not.toContain('normalized-text-verified');
  expect(await api.verifySnapshotReadCatalog(manifest, first)).toMatchObject({ fileCount: 300, bodyVerification: 'not-performed' });
});
test('resolves every path with verified locators and exact alias membership', async () => {
  const api = await load(); const { manifest } = await fixture();
  const catalog = await api.buildSnapshotReadCatalog(manifest);
  for (const file of manifest.files) {
    const result = await api.resolveSnapshotCatalog(catalog.root, catalog.root.sha256, { kind: 'path', path: file.path }, catalog.artifacts);
    expect(result.status).toBe('found');
    if (result.status !== 'found') throw new Error('expected file');
    expect(result.files[0]).toMatchObject({ path: file.path, sourceSha256: file.sha256 });
    expect(result.files[0]?.locators.length).toBeGreaterThan(0);
  }
  for (const object of manifest.objects) {
    const result = await api.resolveSnapshotCatalog(catalog.root, catalog.root.sha256, { kind: 'aliases', path: object.path }, catalog.artifacts);
    expect(result.status).toBe('found');
    if (result.status !== 'found') throw new Error('expected aliases');
    expect(result.aliases.map(a => a.path)).toEqual(manifest.files.filter(f => f.objectPaths.includes(object.path)).map(f => f.path));
  }
});
test('requests missing shards instead of reporting a source file absent', async () => {
  const api = await load(); const { manifest } = await fixture(); const catalog = await api.buildSnapshotReadCatalog(manifest);
  const path = manifest.files[0]?.path; if (!path) throw new Error('fixture');
  const partial = await api.resolveSnapshotCatalog(catalog.root, catalog.root.sha256, { kind: 'path', path }, []);
  expect(partial.status).toBe('needs-artifact');
  const missing = await api.resolveSnapshotCatalog(catalog.root, catalog.root.sha256, { kind: 'path', path: 'not/in/snapshot.ts' }, catalog.artifacts);
  expect(missing).toMatchObject({ status: 'not-in-snapshot', sourceExistence: 'unknown' });
});
test('fails closed on corrupted root, shards, duplicates and forged manifests', async () => {
  const api = await load(); const { manifest } = await fixture(); const catalog = await api.buildSnapshotReadCatalog(manifest);
  const path = manifest.files[0]?.path; if (!path) throw new Error('fixture');
  await expect(api.resolveSnapshotCatalog({ ...catalog.root, content: catalog.root.content + ' ' }, catalog.root.sha256, { kind: 'path', path }, catalog.artifacts)).rejects.toMatchObject({ code: 'OBJECT_INTEGRITY_MISMATCH' });
  const corrupt = catalog.artifacts.map(a => a.path.startsWith('shards/') ? { ...a, content: a.content + ' ' } : a);
  await expect(api.resolveSnapshotCatalog(catalog.root, catalog.root.sha256, { kind: 'path', path }, corrupt)).rejects.toMatchObject({ code: 'OBJECT_INTEGRITY_MISMATCH' });
  await expect(api.verifySnapshotReadCatalog(manifest, { ...catalog, artifacts: catalog.artifacts.slice(1) })).rejects.toBeDefined();
  await expect(api.verifySnapshotReadCatalog(manifest, { ...catalog, artifacts: [...catalog.artifacts, catalog.root] })).rejects.toBeDefined();
  await expect(api.buildSnapshotReadCatalog({ ...manifest, snapshotId: 'snapshot-' + '0'.repeat(64) })).rejects.toMatchObject({ code: 'SNAPSHOT_ID_MISMATCH' });
});
test('splits oversized shards deterministically and enforces total budgets', async () => {
  const api = await load(); const { manifest } = await fixture(400);
  const options = { maxShardBytes: 8192, maxTotalBytes: 10000000, maxArtifactCount: 500 };
  const catalog = await api.buildSnapshotReadCatalog(manifest, options); assertBudgets(catalog, 8192);
  expect(catalog.artifacts.length).toBeGreaterThan(16);
  expect(await api.buildSnapshotReadCatalog(manifest, options)).toEqual(catalog);
  await expect(api.buildSnapshotReadCatalog(manifest, { maxShardBytes: 128 })).rejects.toMatchObject({ code: 'TEXT_READ_LIMIT_EXCEEDED' });
  await expect(api.buildSnapshotReadCatalog(manifest, { maxTotalBytes: 100 })).rejects.toMatchObject({ code: 'TEXT_READ_LIMIT_EXCEEDED' });
  await expect(api.buildSnapshotReadCatalog(manifest, { maxArtifactCount: 1 })).rejects.toMatchObject({ code: 'TEXT_READ_LIMIT_EXCEEDED' });
});
test('rejects unknown schemas, unsafe paths and bounded query overflow', async () => {
  const api = await load(); const { manifest } = await fixture(); const catalog = await api.buildSnapshotReadCatalog(manifest);
  const { makeCatalogArtifact, catalogJson } = await import('../src/read-catalog-codec.js');
  const unknown = await makeCatalogArtifact('CATALOG.json', catalogJson({ ...JSON.parse(catalog.root.content), schemaVersion: 999 }));
  await expect(api.resolveSnapshotCatalog(unknown, unknown.sha256, { kind: 'path', path: 'x.ts' }, catalog.artifacts)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  const invalidManifest = structuredClone(manifest);
  Object.defineProperty(invalidManifest, 'schemaVersion', { value: 999 });
  await expect(api.buildSnapshotReadCatalog(invalidManifest)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(api.resolveSnapshotCatalog(catalog.root, catalog.root.sha256, { kind: 'path', path: '../escape.ts' }, catalog.artifacts)).rejects.toBeDefined();
  const path = manifest.files[0]?.path; if (!path) throw new Error('fixture');
  await expect(api.resolveSnapshotCatalog(catalog.root, catalog.root.sha256, { kind: 'path', path }, catalog.artifacts, { maxArtifacts: 1 })).rejects.toMatchObject({ code: 'TEXT_READ_LIMIT_EXCEEDED' });
});
test('separates exact content aliases from other files packed in the same object', async () => {
  const api = await load(); const { manifest } = await fixture(); const catalog = await api.buildSnapshotReadCatalog(manifest);
  const file = manifest.files.find(f => f.path === 'src/中文 空格🙂.ts'); if (!file) throw new Error('fixture');
  const found = await api.resolveSnapshotCatalog(catalog.root, catalog.root.sha256, { kind: 'path', path: file.path }, catalog.artifacts);
  if (found.status !== 'found' || !found.files[0]?.normalizedSha256 || !file.objectPaths[0]) throw new Error('expected file');
  const normalizedSha256 = found.files[0].normalizedSha256;
  const aliases = await api.resolveSnapshotCatalog(catalog.root, catalog.root.sha256, { kind: 'aliases', path: file.objectPaths[0], normalizedSha256 }, catalog.artifacts);
  if (aliases.status !== 'found') throw new Error('expected aliases');
  expect(aliases.aliases.map(a => a.path)).toEqual(['src/module-1/same.ts', 'src/中文 空格🙂.ts']);
});
test('preserves empty files and legacy object-only verification capabilities', async () => {
  const api = await load();
  for (const textFormatVersion of [1, 2] as const) {
    const staged = await stageSourceTextFile({ path: 'empty.txt', group: 'text', bytes: utf8('') });
    const textPackage = await buildSourceTextPackage([staged], { targetObjectBytes: 2048, maxObjectBytes: 4096, maxObjectCount: 20, maxObjectBytesTotal: 100000, textFormatVersion });
    const manifest = await createTextSnapshotManifest({ projectId: 'empty', policyVersion: 'v1', publishedAt: 1, repositories: [], textPackage });
    const catalog = await api.buildSnapshotReadCatalog(manifest);
    const result = await api.resolveSnapshotCatalog(catalog.root, catalog.root.sha256, { kind: 'path', path: 'empty.txt' }, catalog.artifacts);
    if (result.status !== 'found') throw new Error('expected empty file');
    expect(result.files[0]?.sourceLineCount).toBe(0);
    expect(result.files[0]?.verificationCapabilities).toEqual(textFormatVersion === 2 ? ['object-sha256', 'normalized-text-sha256'] : ['object-sha256']);
  }
});
test('profile-only changes preserve source locators and all content objects', async () => {
  const api = await load(); const { manifest } = await fixture(); const before = JSON.stringify(manifest);
  const path = manifest.files[0]?.path; if (!path) throw new Error('fixture');
  const first = await api.buildSnapshotReadCatalog(manifest);
  const options = { profile: { profileId: 'review', snapshotId: manifest.snapshotId, preferredPaths: [path], referencePaths: [] } };
  const second = await api.buildSnapshotReadCatalog(manifest, options);
  expect(second.root.sha256).not.toBe(first.root.sha256);
  const a = await api.resolveSnapshotCatalog(first.root, first.root.sha256, { kind: 'path', path }, first.artifacts);
  const b = await api.resolveSnapshotCatalog(second.root, second.root.sha256, { kind: 'path', path }, second.artifacts);
  if (a.status !== 'found' || b.status !== 'found') throw new Error('expected file');
  expect(b.files[0]).toEqual({ ...a.files[0], priority: 'preferred' });
  expect(JSON.stringify(manifest)).toBe(before);
  expect(await api.verifySnapshotReadCatalog(manifest, second)).toMatchObject({ fileCount: 6 });
});
test('splits one large alias family without creating a file-per-source directory', async () => {
  const api = await load(); const { manifest: base } = await fixture(1);
  const { createSnapshotManifest } = await import('../src/index.js');
  const source = base.files[0]; const object = base.objects[0]; if (!source || !object) throw new Error('fixture');
  const files = Array.from({ length: 1000 }, (_, i) => ({ ...source, path: `aliases/${String(i).padStart(5, '0')}.ts` }));
  const manifest = await createSnapshotManifest({ ...base, files });
  const options = { maxShardBytes: 8192, maxArtifactCount: 1000 };
  const catalog = await api.buildSnapshotReadCatalog(manifest, options);
  await expect(api.resolveSnapshotCatalog(catalog.root, catalog.root.sha256, { kind: 'aliases', path: object.path }, catalog.artifacts, { maxArtifacts: 256 })).rejects.toMatchObject({ code: 'TEXT_READ_LIMIT_EXCEEDED' });
  const result = await api.resolveSnapshotCatalog(catalog.root, catalog.root.sha256, { kind: 'aliases', path: object.path }, catalog.artifacts, { maxArtifacts: catalog.artifacts.length + 1 });
  if (result.status !== 'found') throw new Error('expected aliases');
  expect(result.aliases.map(a => a.path)).toEqual(files.map(f => f.path));
  const defaultCatalog = await api.buildSnapshotReadCatalog(manifest);
  expect(defaultCatalog.artifacts.length).toBeLessThan(files.length / 2); assertBudgets(catalog, 8192);
});
test('rejects a self-consistent but unbound catalog in full manifest verification', async () => {
  const api = await load(); const { manifest } = await fixture(); const catalog = await api.buildSnapshotReadCatalog(manifest);
  const { makeCatalogArtifact, catalogJson } = await import('../src/read-catalog-codec.js');
  const altered = JSON.parse(catalog.root.content); altered.manifestDigest = '0'.repeat(64);
  const root = await makeCatalogArtifact('CATALOG.json', catalogJson(altered));
  const artifacts = catalog.artifacts.map(a => a.path === root.path ? root : a);
  await expect(api.verifySnapshotReadCatalog(manifest, { ...catalog, root, artifacts })).rejects.toMatchObject({ code: 'OBJECT_INTEGRITY_MISMATCH' });
});
test('keeps a common 10k-file lookup within three catalog reads before one object read', async () => {
  const api = await load(); const { manifest: base } = await fixture(1);
  const { createSnapshotManifest } = await import('../src/index.js'); const source = base.files[0];
  if (!source) throw new Error('fixture');
  const files = Array.from({ length: 10000 }, (_, i) => ({ ...source, path: `modules/${String(i).padStart(5, '0')}/main.ts` }));
  const manifest = await createSnapshotManifest({ ...base, files }); const catalog = await api.buildSnapshotReadCatalog(manifest);
  const result = await api.resolveSnapshotCatalog(catalog.root, catalog.root.sha256, { kind: 'path', path: 'modules/05000/main.ts' }, catalog.artifacts);
  if (result.status !== 'found') throw new Error('expected file');
  expect(result.verifiedArtifactCount).toBeLessThanOrEqual(3);
  expect(catalog.root.byteLength).toBeLessThanOrEqual(65536);
}, 30000);
