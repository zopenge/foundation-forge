import type { CatalogAlias, CatalogFile, CatalogNode, CatalogRoot, CatalogRoute, CatalogScope } from './read-catalog-contracts.js';
import { catalogCount, catalogDigest, catalogInvalid, catalogLimits, catalogPath, catalogRecord, catalogReference, catalogString } from './read-catalog-codec.js';
const array = (value: unknown): readonly unknown[] => Array.isArray(value) ? value : catalogInvalid('catalog-array');
export const parseCatalogRoot = (value: unknown): CatalogRoot => {
  const data = catalogRecord(value);
  if (data.schemaVersion !== 1 || data.kind !== 'source-snapshot-read-catalog' || data.routing !== 'sha256-prefix-v1') catalogInvalid('catalog-schema');
  const snapshotId = catalogString(data.snapshotId, 'snapshotId');
  if (!/^snapshot-[a-f0-9]{64}$/u.test(snapshotId)) catalogInvalid('snapshotId');
  const raw = catalogRecord(data.limits);
  const limits = catalogLimits({ maxRootBytes: catalogCount(raw.maxRootBytes, 'maxRootBytes'), maxShardBytes: catalogCount(raw.maxShardBytes, 'maxShardBytes'),
    maxTotalBytes: catalogCount(raw.maxTotalBytes, 'maxTotalBytes'), maxArtifactCount: catalogCount(raw.maxArtifactCount, 'maxArtifactCount') });
  return { schemaVersion: 1, kind: 'source-snapshot-read-catalog', routing: 'sha256-prefix-v1', snapshotId, limits,
    manifestDigest: catalogDigest(data.manifestDigest), profileDigest: catalogDigest(data.profileDigest),
    fileCount: catalogCount(data.fileCount, 'fileCount'), objectCount: catalogCount(data.objectCount, 'objectCount'),
    paths: parseCatalogRoute(data.paths, 'paths'), aliases: parseCatalogRoute(data.aliases, 'aliases') };
};
const parseAlias = (value: unknown): CatalogAlias => {
  const data = catalogRecord(value);
  return { path: catalogPath(data.path), objectPath: catalogPath(data.objectPath), sourceSha256: catalogDigest(data.sourceSha256),
    ...(data.normalizedSha256 === undefined ? {} : { normalizedSha256: catalogDigest(data.normalizedSha256) }) };
};
const parseFile = (value: unknown): CatalogFile => {
  const data = catalogRecord(value);
  const formatVersion = data.formatVersion === 1 ? 1 : data.formatVersion === 2 ? 2 : catalogInvalid('catalog-format');
  const priority = data.priority === 'preferred' ? 'preferred' : data.priority === 'reference' ? 'reference' : data.priority === 'unclassified' ? 'unclassified' : catalogInvalid('catalog-priority');
  const capabilities = array(data.verificationCapabilities).map(v => catalogString(v, 'capability'));
  const expected = data.formatVersion === 2 ? ['object-sha256', 'normalized-text-sha256'] : ['object-sha256'];
  if (JSON.stringify(capabilities) !== JSON.stringify(expected)) catalogInvalid('catalog-capabilities');
  const objectRequirements = array(data.objectRequirements).map(value => {
    const item = catalogRecord(value); return { path: catalogPath(item.path), sha256: catalogDigest(item.sha256), byteLength: catalogCount(item.byteLength, 'object.byteLength') };
  });
  const objects = new Map(objectRequirements.map(o => [o.path, o]));
  if (objects.size !== objectRequirements.length || objects.size === 0) catalogInvalid('catalog-objects');
  const sourceLineCount = catalogCount(data.sourceLineCount, 'sourceLineCount');
  const locators = array(data.locators).map(value => {
    const item = catalogRecord(value);
    const locator = { objectPath: catalogPath(item.objectPath), objectSha256: catalogDigest(item.objectSha256),
      bodyByteOffset: catalogCount(item.bodyByteOffset, 'bodyByteOffset'), bodyByteLength: catalogCount(item.bodyByteLength, 'bodyByteLength'),
      sourceByteOffset: catalogCount(item.sourceByteOffset, 'sourceByteOffset'), segmentIndex: catalogCount(item.segmentIndex, 'segmentIndex'),
      segmentCount: catalogCount(item.segmentCount, 'segmentCount'), startLine: catalogCount(item.startLine, 'startLine'), endLine: catalogCount(item.endLine, 'endLine') };
    const object = objects.get(locator.objectPath);
    if (!object || object.sha256 !== locator.objectSha256 || locator.bodyByteOffset > object.byteLength - locator.bodyByteLength ||
      locator.segmentIndex < 1 || locator.segmentIndex > locator.segmentCount || locator.startLine > locator.endLine || locator.endLine > sourceLineCount) catalogInvalid('catalog-locator');
    return locator;
  });
  if ((data.formatVersion === 1 && locators.length !== 0) || (data.formatVersion === 2 && locators.length === 0)) catalogInvalid('catalog-locators');
  return { path: catalogPath(data.path), sourceSha256: catalogDigest(data.sourceSha256), sourceByteLength: catalogCount(data.sourceByteLength, 'sourceByteLength'),
    sourceLineCount, group: catalogString(data.group, 'group'), formatVersion, priority,
    verificationCapabilities: capabilities, objectRequirements, locators,
    ...(data.formatVersion === 2 ? { normalizedSha256: catalogDigest(data.normalizedSha256), normalizedByteLength: catalogCount(data.normalizedByteLength, 'normalizedByteLength') } : {}) };
};
export const parseCatalogNode = (value: unknown, scope: CatalogScope, prefix: string): CatalogNode => {
  const data = catalogRecord(value);
  if (data.schemaVersion !== 1 || data.scope !== scope || data.prefix !== prefix || (data.kind !== 'leaf' && data.kind !== 'branch')) catalogInvalid('catalog-node');
  if (data.kind === 'branch') {
    if (data.entries !== undefined) catalogInvalid('catalog-branch-entries');
    const children = array(data.children).map(value => catalogReference(value, scope));
    if (children.length < 1 || children.length > 16) catalogInvalid('catalog-branch-size');
    const next = new Set<string>();
    for (const child of children) {
      if (!child.prefix.startsWith(prefix) || child.prefix.length <= prefix.length) catalogInvalid('catalog-prefix');
      const nibble = child.prefix.slice(prefix.length, prefix.length + 1);
      if (next.has(nibble)) catalogInvalid('catalog-overlapping-prefix'); next.add(nibble);
    }
    return { schemaVersion: 1, kind: 'branch', scope, prefix, children };
  }
  if (data.children !== undefined) catalogInvalid('catalog-leaf-children');
  const keys = new Set<string>();
  const entries = array(data.entries).map(value => {
    const item = catalogRecord(value); const key = catalogString(item.key, 'key');
    if (!/^[a-f0-9]+$/u.test(key) || key.length !== (scope === 'paths' ? 64 : 128) || !key.startsWith(prefix) || keys.has(key)) catalogInvalid('catalog-key');
    keys.add(key); return { key, record: scope === 'paths' ? parseFile(item.record) : parseAlias(item.record) };
  });
  return { schemaVersion: 1, kind: 'leaf', scope, prefix, entries };
};
function parseCatalogRoute(value: unknown, scope: CatalogScope): CatalogRoute {
  const data = catalogRecord(value);
  if (data.children === undefined) return catalogReference(data, scope);
  if (data.path !== undefined) catalogInvalid('catalog-route');
  const prefix = catalogString(data.prefix, 'route-prefix');
  if (!/^[a-f0-9]*$/u.test(prefix) || prefix.length > (scope === 'paths' ? 64 : 128)) catalogInvalid('route-prefix');
  const node = parseCatalogNode({ schemaVersion: 1, kind: 'branch', scope, prefix, children: data.children }, scope, prefix);
  return { prefix, children: node.children ?? catalogInvalid('catalog-route-children') };
}
