import { calculateBytesIntegrity } from '@openge/forge-artifact-integrity';
import { assertJsonValue, stringifyDeterministicJson } from '@openge/forge-deterministic-json';
import { validatePortableRelativePath } from '@openge/forge-path-safety';
import { SourceSnapshotError } from './errors.js';
import type { CatalogArtifact, CatalogLimits, CatalogReference, ReadCatalogOptions } from './read-catalog-contracts.js';
export const catalogInvalid = (field: string): never => { throw new SourceSnapshotError('INVALID_INPUT', { field }); };
export const catalogLimit = (field: string): never => { throw new SourceSnapshotError('TEXT_READ_LIMIT_EXCEEDED', { field }); };
export const catalogJson = (value: unknown): string => { assertJsonValue(value); return stringifyDeterministicJson(value); };
export const catalogHash = async (content: string): Promise<string> => (await calculateBytesIntegrity(new TextEncoder().encode(content))).sha256;
export const catalogLimits = (input: ReadCatalogOptions = {}): CatalogLimits => {
  const limits = { maxRootBytes: input.maxRootBytes ?? 65536, maxShardBytes: input.maxShardBytes ?? 262144,
    maxTotalBytes: input.maxTotalBytes ?? 67108864, maxArtifactCount: input.maxArtifactCount ?? 4096 };
  for (const [key, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value <= 0) catalogInvalid(key);
  if (limits.maxRootBytes > 65536 || limits.maxShardBytes > 262144) catalogInvalid('catalog-hard-limit');
  return Object.freeze(limits);
};
export const makeCatalogArtifact = async (path: string, content: string): Promise<CatalogArtifact> => {
  const integrity = await calculateBytesIntegrity(new TextEncoder().encode(content));
  return Object.freeze({ path, content, ...integrity });
};
export const checkedArtifact = async (artifact: CatalogArtifact, expected: { readonly path: string; readonly sha256: string; readonly byteLength: number }, limit: number): Promise<unknown> => {
  if (typeof artifact.content !== 'string' || artifact.content.length > limit || expected.byteLength > limit) catalogLimit('catalog-artifact');
  const integrity = await calculateBytesIntegrity(new TextEncoder().encode(artifact.content));
  if (artifact.path !== expected.path || artifact.sha256 !== expected.sha256 || artifact.byteLength !== expected.byteLength || integrity.byteLength !== expected.byteLength || integrity.sha256 !== expected.sha256) {
    throw new SourceSnapshotError('OBJECT_INTEGRITY_MISMATCH', { path: expected.path });
  }
  try { return JSON.parse(artifact.content) as unknown; } catch { return catalogInvalid('catalog-json'); }
};
export const catalogRecord = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return catalogInvalid('catalog-record');
  return value as Record<string, unknown>;
};
export const catalogString = (value: unknown, field: string): string => typeof value === 'string' ? value : catalogInvalid(field);
export const catalogCount = (value: unknown, field: string): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : catalogInvalid(field);
export const catalogDigest = (value: unknown): string => {
  const text = catalogString(value, 'digest'); if (!/^[a-f0-9]{64}$/u.test(text)) catalogInvalid('digest'); return text;
};
export const catalogPath = (value: unknown): string => {
  const text = catalogString(value, 'path'); validatePortableRelativePath(text); return text;
};
export const catalogReference = (value: unknown, scope: 'paths' | 'aliases'): CatalogReference => {
  const data = catalogRecord(value); const sha256 = catalogDigest(data.sha256);
  const path = catalogPath(data.path); const prefix = catalogString(data.prefix, 'prefix');
  if (path !== `shards/${scope}-${sha256}.json` || !/^[a-f0-9]*$/u.test(prefix) || prefix.length > (scope === 'paths' ? 64 : 128)) catalogInvalid('catalog-reference');
  return { path, prefix, sha256, byteLength: catalogCount(data.byteLength, 'byteLength') };
};
export const snapshotCatalogMap = (artifacts: readonly CatalogArtifact[]): ReadonlyMap<string, CatalogArtifact> => {
  const map = new Map<string, CatalogArtifact>();
  for (const artifact of artifacts) {
    if (map.has(artifact.path)) throw new SourceSnapshotError('OBJECT_CONFLICT', { path: artifact.path });
    map.set(artifact.path, artifact);
  }
  return map;
};
