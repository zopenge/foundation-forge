import type { CatalogAlias, CatalogArtifact, CatalogFile, CatalogQuery, CatalogReadBudget, CatalogResolution } from './read-catalog-contracts.js';
import { catalogDigest, catalogHash, catalogInvalid, catalogLimit, catalogPath, checkedArtifact, snapshotCatalogMap } from './read-catalog-codec.js';
import { parseCatalogNode, parseCatalogRoot } from './read-catalog-parse.js';
import { compareStrings } from './validation.js';

/** 仅消费显式提供的制品；缺项返回读取需求，不调用任何 Provider。 */
export const resolveSnapshotCatalog = async (
  rootArtifact: CatalogArtifact, expectedDigest: string, query: CatalogQuery,
  artifacts: readonly CatalogArtifact[], budget: CatalogReadBudget = {},
): Promise<CatalogResolution> => {
  const maxArtifacts = budget.maxArtifacts ?? 64; const maxBytes = budget.maxBytes ?? 8388608;
  if (!Number.isSafeInteger(maxArtifacts) || maxArtifacts < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) catalogInvalid('catalog-read-budget');
  catalogDigest(expectedDigest); const path = catalogPath(query.path);
  if (query.kind !== 'path' && query.kind !== 'aliases') catalogInvalid('catalog-query-kind');
  const normalized = query.normalizedSha256 === undefined ? undefined : catalogDigest(query.normalizedSha256);
  if (normalized !== undefined && query.kind !== 'aliases') catalogInvalid('catalog-query-filter');
  const supplied = snapshotCatalogMap(artifacts);
  const raw = await checkedArtifact(rootArtifact, { path: 'CATALOG.json', sha256: expectedDigest, byteLength: rootArtifact.byteLength }, Math.min(65536, maxBytes));
  const root = parseCatalogRoot(raw);
  if (rootArtifact.byteLength > root.limits.maxRootBytes) catalogLimit('catalog-root');
  const key = await catalogHash(path); const scope = query.kind === 'path' ? 'paths' : 'aliases';
  const route = scope === 'paths' ? root.paths : root.aliases;
  const queue = 'children' in route ? [...route.children] : [route];
  const seen = new Set<string>(); const files: CatalogFile[] = []; const aliases: CatalogAlias[] = [];
  let verifiedBytes = rootArtifact.byteLength; let verifiedArtifactCount = 1;
  while (queue.length > 0) {
    const ref = queue.pop(); if (!ref) break;
    const intersects = key.startsWith(ref.prefix) || (scope === 'aliases' && ref.prefix.startsWith(key));
    if (!intersects) continue;
    if (seen.has(ref.path)) catalogInvalid('catalog-cycle'); seen.add(ref.path);
    if (verifiedArtifactCount >= maxArtifacts || ref.byteLength > maxBytes - verifiedBytes) catalogLimit('catalog-read-budget');
    const artifact = supplied.get(ref.path);
    if (!artifact) return Object.freeze({ status: 'needs-artifact', requirement: ref });
    const node = parseCatalogNode(await checkedArtifact(artifact, ref, root.limits.maxShardBytes), scope, ref.prefix);
    verifiedBytes += artifact.byteLength; verifiedArtifactCount += 1;
    if (node.kind === 'branch') { queue.push(...(node.children ?? [])); continue; }
    for (const entry of node.entries ?? []) {
      const record = entry.record; const fileKey = await catalogHash(record.path);
      const actualKey = 'objectPath' in record ? (await catalogHash(record.objectPath)) + fileKey : fileKey;
      if (actualKey !== entry.key) catalogInvalid('catalog-record-key');
      if ('objectPath' in record) { if (record.objectPath === path && (normalized === undefined || record.normalizedSha256 === normalized)) aliases.push(record); }
      else if (record.path === path) files.push(record);
    }
  }
  if (files.length === 0 && aliases.length === 0) return Object.freeze({ status: 'not-in-snapshot', sourceExistence: 'unknown', catalogDigest: expectedDigest });
  return Object.freeze({ status: 'found', snapshotId: root.snapshotId, catalogDigest: expectedDigest,
    files: Object.freeze(files.sort((a, b) => compareStrings(a.path, b.path))),
    aliases: Object.freeze(aliases.sort((a, b) => compareStrings(a.path, b.path))),
    verifiedArtifactCount, verifiedBytes, bodyVerification: 'not-performed' });
};
