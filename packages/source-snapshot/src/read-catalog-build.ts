import type { SnapshotManifest } from './contracts.js';
import type { SnapshotReadProfile } from './content-contracts.js';
import type { CatalogEntry, CatalogFile, ReadCatalogBundle, ReadCatalogOptions } from './read-catalog-contracts.js';
import { catalogHash, catalogInvalid, catalogJson, catalogLimits, catalogPath } from './read-catalog-codec.js';
import { CatalogArtifactBuilder } from './read-catalog-tree.js';
import { createSnapshotManifest } from './manifest.js';
import { buildSnapshotReadIndex } from './read-index.js';
import { SourceSnapshotError } from './errors.js';
import { compareStrings } from './validation.js';
const captureProfile = (profile: SnapshotReadProfile | undefined, snapshotId: string): SnapshotReadProfile | undefined => {
  if (!profile) return undefined;
  if (profile.snapshotId !== snapshotId) throw new SourceSnapshotError('ANALYSIS_SOURCE_MISMATCH', { field: 'snapshotId' });
  if (typeof profile.profileId !== 'string' || !profile.profileId.trim()) catalogInvalid('profileId');
  const normalize = (paths: readonly string[]) => Object.freeze([...new Set(paths.map(catalogPath))].sort(compareStrings));
  return Object.freeze({ profileId: profile.profileId, snapshotId, preferredPaths: normalize(profile.preferredPaths), referencePaths: normalize(profile.referencePaths) });
};
/** 从 manifest 生成独立投影；不读取正文，不写回源码 store。 */
export const buildSnapshotReadCatalog = async (input: SnapshotManifest, options: ReadCatalogOptions = {}): Promise<ReadCatalogBundle> => {
  if (input.schemaVersion !== 1) catalogInvalid('manifest-schema');
  const snapshotId = input.snapshotId; const limits = catalogLimits(options);
  const profile = captureProfile(options.profile, snapshotId);
  const manifest = await createSnapshotManifest(input);
  if (manifest.snapshotId !== snapshotId) throw new SourceSnapshotError('SNAPSHOT_ID_MISMATCH', { snapshotId });
  const manifestDigest = await catalogHash(catalogJson(manifest));
  const profileDigest = await catalogHash(catalogJson(profile ?? null));
  const index = buildSnapshotReadIndex(manifest);
  const preferred = new Set(profile?.preferredPaths); const reference = new Set(profile?.referencePaths);
  const objectKeys = new Map<string, string>();
  for (const object of manifest.objects) objectKeys.set(object.path, await catalogHash(object.path));
  const pathEntries: CatalogEntry[] = []; const aliasEntries: CatalogEntry[] = [];
  for (const file of index.files) {
    const key = await catalogHash(file.path);
    const { assurance: legacyDeclaration, ...source } = file;
    const record: CatalogFile = Object.freeze({ ...source,
      verificationCapabilities: Object.freeze(legacyDeclaration === 'normalized-text-verified' ? ['object-sha256', 'normalized-text-sha256'] : ['object-sha256']),
      priority: preferred.has(file.path) ? 'preferred' : reference.has(file.path) ? 'reference' : 'unclassified' });
    pathEntries.push({ key, record });
    for (const object of file.objectRequirements) {
      const objectKey = objectKeys.get(object.path); if (!objectKey) catalogInvalid('object-key');
      aliasEntries.push({ key: `${objectKey}${key}`, record: { objectPath: object.path, path: file.path,
        sourceSha256: file.sourceSha256, ...(file.normalizedSha256 ? { normalizedSha256: file.normalizedSha256 } : {}) } });
    }
  }
  const builder = new CatalogArtifactBuilder(limits);
  const paths = await builder.route('paths', pathEntries); const aliases = await builder.route('aliases', aliasEntries);
  const root = await builder.add('CATALOG.json', catalogJson({ schemaVersion: 1, kind: 'source-snapshot-read-catalog',
    snapshotId, manifestDigest, profileDigest, fileCount: manifest.files.length, objectCount: manifest.objects.length,
    routing: 'sha256-prefix-v1', limits, paths, aliases,
    lineCoordinates: { source: 'normalized-source-one-based', object: 'UTF-8-byte-offsets', connector: 'provider-specific-not-source-lines' },
    bodyVerification: 'not-performed', sourceExistenceOutsideManifest: 'unknown' }), limits.maxRootBytes);
  await builder.add('README.md', ['# Source Snapshot Read Catalog', '', `Snapshot: ${snapshotId}`, `Catalog SHA-256: ${root.sha256}`,
    `Files: ${manifest.files.length}; objects: ${manifest.objects.length}`, '',
    'Start at CATALOG.json. Exact path: SHA-256 of the UTF-8 source path; follow matching prefix references.',
    'Object aliases: SHA-256 of the UTF-8 object path; follow intersecting prefixes in the aliases tree.',
    'Pin the catalog digest only after full manifest/catalog comparison. Verify each required artifact hash.',
    'Missing shards require retrieval, not a file-absence claim. Paths not in this catalog have unknown source existence.',
    'Source lines, object byte offsets and connector display lines are different coordinates. No source-body verification is implied.', ''].join('\n'), limits.maxRootBytes);
  return Object.freeze({ root, artifacts: builder.values(), totalBytes: builder.totalBytes(), options: Object.freeze({ ...limits, ...(profile ? { profile } : {}) }) });
};
