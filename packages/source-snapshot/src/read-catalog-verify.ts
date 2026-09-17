import type { SnapshotManifest } from './contracts.js';
import type { ReadCatalogBundle } from './read-catalog-contracts.js';
import { buildSnapshotReadCatalog } from './read-catalog-build.js';
import { makeCatalogArtifact, snapshotCatalogMap } from './read-catalog-codec.js';
import { SourceSnapshotError } from './errors.js';

/** 完整比较派生目录与 manifest；不把元数据一致性标成正文验证。 */
export const verifySnapshotReadCatalog = async (manifest: SnapshotManifest, bundle: ReadCatalogBundle) => {
  const expected = await buildSnapshotReadCatalog(manifest, bundle.options);
  const provided = snapshotCatalogMap(bundle.artifacts);
  if (provided.size !== expected.artifacts.length || bundle.totalBytes !== expected.totalBytes) throw new SourceSnapshotError('OBJECT_INTEGRITY_MISMATCH', { field: 'catalog-artifacts' });
  if (bundle.root.content !== expected.root.content || bundle.root.sha256 !== expected.root.sha256 || bundle.root.path !== expected.root.path || bundle.root.byteLength !== expected.root.byteLength) {
    throw new SourceSnapshotError('OBJECT_INTEGRITY_MISMATCH', { field: 'catalog-root' });
  }
  for (const item of expected.artifacts) {
    const actual = provided.get(item.path);
    if (!actual) throw new SourceSnapshotError('OBJECT_MISSING', { path: item.path });
    if (actual.content !== item.content || actual.byteLength !== item.byteLength || actual.sha256 !== item.sha256) {
      throw new SourceSnapshotError('OBJECT_INTEGRITY_MISMATCH', { path: item.path });
    }
    const checked = await makeCatalogArtifact(actual.path, actual.content);
    if (checked.sha256 !== item.sha256 || checked.byteLength !== item.byteLength) throw new SourceSnapshotError('OBJECT_INTEGRITY_MISMATCH', { path: item.path });
  }
  return Object.freeze({ scope: 'manifest-and-catalog', snapshotId: manifest.snapshotId, catalogDigest: expected.root.sha256,
    fileCount: manifest.files.length, objectCount: manifest.objects.length, artifactCount: expected.artifacts.length,
    bodyVerification: 'not-performed' as const });
};
