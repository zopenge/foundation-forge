import { calculateBytesIntegrity } from '@openge/forge-artifact-integrity';
import { validatePortableRelativePath } from '@openge/forge-path-safety';
import type { SnapshotManifest } from './contracts.js';
import type { SnapshotEvidence, SnapshotEvidenceArtifactBytes, SnapshotEvidenceArtifactRef, SnapshotEvidenceJson, SnapshotEvidenceValidation, SnapshotRelation, SnapshotRelationsValidation } from './content-contracts.js';
import { SourceSnapshotError } from './errors.js';
import { compareStrings } from './validation.js';

const idPattern = /^[A-Za-z0-9._:-]{1,128}$/u;
const hashPattern = /^[a-f0-9]{64}$/u;
const kinds = new Set(['imports', 'exports', 'references']);
const resolutions = new Set(['resolved', 'unresolved', 'external']);
const mismatch = (details: Readonly<Record<string, unknown>>): never => {
  throw new SourceSnapshotError('ANALYSIS_SOURCE_MISMATCH', details);
};
const requirePortablePath = (value: string, field: string): void => {
  try { validatePortableRelativePath(value); }
  catch { throw new SourceSnapshotError('INVALID_INPUT', { field, value }); }
};
const normalizeDiagnostics = (value: readonly string[] | undefined, relationId: string): readonly string[] => {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 32) throw new SourceSnapshotError('INVALID_INPUT', { relationId, field: 'diagnostics' });
  const diagnostics = value.map(item => {
    if (typeof item !== 'string' || item.length === 0 || item.length > 512) {
      throw new SourceSnapshotError('INVALID_INPUT', { relationId, field: 'diagnostics' });
    }
    return item;
  });
  return Object.freeze([...diagnostics].sort(compareStrings));
};

const normalizeRelation = (manifest: SnapshotManifest, relation: SnapshotRelation): SnapshotRelation => {
  if (typeof relation !== 'object' || relation === null) throw new SourceSnapshotError('INVALID_INPUT', { field: 'relation' });
  if (!idPattern.test(relation.relationId)) throw new SourceSnapshotError('INVALID_INPUT', { field: 'relationId' });
  if (relation.snapshotId !== manifest.snapshotId) mismatch({ relationId: relation.relationId, field: 'snapshotId' });
  if (!kinds.has(relation.kind)) throw new SourceSnapshotError('INVALID_INPUT', { relationId: relation.relationId, field: 'kind' });
  if (!resolutions.has(relation.resolution)) throw new SourceSnapshotError('INVALID_INPUT', { relationId: relation.relationId, field: 'resolution' });
  requirePortablePath(relation.fromPath, 'fromPath');
  if (!hashPattern.test(relation.sourceSha256)) throw new SourceSnapshotError('INVALID_INPUT', { relationId: relation.relationId, field: 'sourceSha256' });
  const from = manifest.files.find(file => file.path === relation.fromPath);
  if (from === undefined || from.sha256 !== relation.sourceSha256) {
    mismatch({ relationId: relation.relationId, field: 'fromPath', path: relation.fromPath });
  }
  if (relation.resolution === 'resolved') {
    if (typeof relation.toPath !== 'string' || relation.toPath.length === 0) {
      throw new SourceSnapshotError('INVALID_INPUT', { relationId: relation.relationId, field: 'toPath' });
    }
    requirePortablePath(relation.toPath, 'toPath');
    if (!manifest.files.some(file => file.path === relation.toPath)) {
      mismatch({ relationId: relation.relationId, field: 'toPath', path: relation.toPath });
    }
  } else if (relation.toPath !== undefined && (typeof relation.toPath !== 'string' || relation.toPath.length === 0 || relation.toPath.length > 1024)) {
    throw new SourceSnapshotError('INVALID_INPUT', { relationId: relation.relationId, field: 'toPath' });
  }
  const diagnostics = normalizeDiagnostics(relation.diagnostics, relation.relationId);
  return Object.freeze({ ...relation, ...(relation.toPath === undefined ? {} : { toPath: relation.toPath }), diagnostics });
};

export const validateSnapshotRelations = (
  manifest: SnapshotManifest,
  relations: readonly SnapshotRelation[],
): SnapshotRelationsValidation => {
  if (!Array.isArray(relations)) throw new SourceSnapshotError('INVALID_INPUT', { field: 'relations' });
  const normalized = relations.map(relation => normalizeRelation(manifest, relation));
  const ids = new Set<string>();
  for (const relation of normalized) {
    if (ids.has(relation.relationId)) throw new SourceSnapshotError('INVALID_INPUT', { field: 'relationId', relationId: relation.relationId });
    ids.add(relation.relationId);
  }
  const ordered = Object.freeze([...normalized].sort((a, b) => compareStrings(a.relationId, b.relationId)));
  return Object.freeze({ schemaVersion: 1, snapshotId: manifest.snapshotId, relationCount: ordered.length, relations: ordered });
};

const evidenceKinds = new Set(['static', 'unit', 'integration', 'runtime']);
const evidenceStatuses = new Set(['passed', 'failed', 'blocked', 'not-run']);
const forbiddenEvidenceKeys = new Set([
  'stdout', 'stderr', 'error', 'secret', 'token', 'password', 'authorization',
  'matchedvalue', 'matchvalue', 'blockedvalue',
]);
const evidenceEncoder = new TextEncoder();
const maxEvidenceJsonBytes = 65_536;
const maxEvidenceJsonDepth = 8;
const maxEvidenceArtifacts = 128;

const normalizeEvidenceJson = (
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet<object>(),
): SnapshotEvidenceJson => {
  if (depth > maxEvidenceJsonDepth) throw new SourceSnapshotError('INVALID_INPUT', { field: 'environment', reason: 'depth' });
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new SourceSnapshotError('INVALID_INPUT', { field: 'environment' });
    return value;
  }
  if (typeof value !== 'object' || value === undefined) {
    throw new SourceSnapshotError('INVALID_INPUT', { field: 'environment', reason: 'non-json' });
  }
  if (seen.has(value)) throw new SourceSnapshotError('INVALID_INPUT', { field: 'environment', reason: 'cycle' });
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(value.map(item => normalizeEvidenceJson(item, depth + 1, seen)));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new SourceSnapshotError('INVALID_INPUT', { field: 'environment', reason: 'non-json-object' });
    }
    const entries: Array<[string, SnapshotEvidenceJson]> = [];
    for (const key of Object.keys(value).sort(compareStrings)) {
      if (forbiddenEvidenceKeys.has(key.toLowerCase())) {
        throw new SourceSnapshotError('INVALID_INPUT', { field: `environment.${key}`, reason: 'sensitive-field' });
      }
      if (key.length === 0 || key.length > 128) throw new SourceSnapshotError('INVALID_INPUT', { field: 'environment', reason: 'key' });
      entries.push([key, normalizeEvidenceJson((value as Record<string, unknown>)[key], depth + 1, seen)]);
    }
    return Object.freeze(Object.fromEntries(entries));
  } finally {
    seen.delete(value);
  }
};
const normalizeEnvironment = (value: SnapshotEvidenceJson | undefined): SnapshotEvidenceJson | undefined => {
  if (value === undefined) return undefined;
  const normalized = normalizeEvidenceJson(value);
  const bytes = evidenceEncoder.encode(JSON.stringify(normalized)).byteLength;
  if (bytes > maxEvidenceJsonBytes) throw new SourceSnapshotError('INVALID_INPUT', { field: 'environment', reason: 'size' });
  return normalized;
};

const requireEvidenceId = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !idPattern.test(value)) throw new SourceSnapshotError('INVALID_INPUT', { field });
  return value;
};
const requireCount = (value: unknown, field: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new SourceSnapshotError('INVALID_INPUT', { field });
  return value as number;
};
const normalizeArtifactRefs = (refs: readonly SnapshotEvidenceArtifactRef[]): readonly SnapshotEvidenceArtifactRef[] => {
  if (!Array.isArray(refs) || refs.length > maxEvidenceArtifacts) throw new SourceSnapshotError('INVALID_INPUT', { field: 'artifactRefs' });
  const ids = new Set<string>();
  const normalized = refs.map(ref => {
    if (typeof ref !== 'object' || ref === null) throw new SourceSnapshotError('INVALID_INPUT', { field: 'artifactRef' });
    const artifactId = requireEvidenceId(ref.artifactId, 'artifactId');
    if (ids.has(artifactId)) throw new SourceSnapshotError('INVALID_INPUT', { field: 'artifactId', artifactId });
    ids.add(artifactId);
    if (!hashPattern.test(ref.sha256)) throw new SourceSnapshotError('INVALID_INPUT', { field: 'artifactSha256', artifactId });
    const byteLength = requireCount(ref.byteLength, 'artifactByteLength');
    return Object.freeze({ artifactId, sha256: ref.sha256, byteLength });
  });
  return Object.freeze(normalized.sort((a, b) => compareStrings(a.artifactId, b.artifactId)));
};
const providedArtifactMap = (artifacts: readonly SnapshotEvidenceArtifactBytes[]): ReadonlyMap<string, Uint8Array> => {
  if (!Array.isArray(artifacts) || artifacts.length > maxEvidenceArtifacts) throw new SourceSnapshotError('INVALID_INPUT', { field: 'artifacts' });
  const map = new Map<string, Uint8Array>();
  for (const artifact of artifacts) {
    if (typeof artifact !== 'object' || artifact === null) throw new SourceSnapshotError('INVALID_INPUT', { field: 'artifact' });
    const artifactId = requireEvidenceId(artifact.artifactId, 'artifactId');
    if (map.has(artifactId)) throw new SourceSnapshotError('INVALID_INPUT', { field: 'artifactId', artifactId });
    if (!(artifact.bytes instanceof Uint8Array)) throw new SourceSnapshotError('INVALID_INPUT', { field: 'artifactBytes', artifactId });
    map.set(artifactId, artifact.bytes);
  }
  return map;
};

export const validateSnapshotEvidence = async (
  manifest: SnapshotManifest,
  evidence: SnapshotEvidence,
  artifacts: readonly SnapshotEvidenceArtifactBytes[],
): Promise<SnapshotEvidenceValidation> => {
  if (typeof evidence !== 'object' || evidence === null) throw new SourceSnapshotError('INVALID_INPUT', { field: 'evidence' });
  const evidenceId = requireEvidenceId(evidence.evidenceId, 'evidenceId');
  if (evidence.snapshotId !== manifest.snapshotId) mismatch({ evidenceId, field: 'snapshotId' });
  const producer = requireEvidenceId(evidence.producer, 'producer');
  const producerVersion = requireEvidenceId(evidence.producerVersion, 'producerVersion');
  if (!evidenceKinds.has(evidence.kind)) throw new SourceSnapshotError('INVALID_INPUT', { evidenceId, field: 'kind' });
  if (!evidenceStatuses.has(evidence.status)) throw new SourceSnapshotError('INVALID_INPUT', { evidenceId, field: 'status' });
  const collected = requireCount(evidence.collected, 'collected');
  const passed = requireCount(evidence.passed, 'passed');
  const failed = requireCount(evidence.failed, 'failed');
  const skipped = requireCount(evidence.skipped, 'skipped');
  if (passed + failed + skipped !== collected) throw new SourceSnapshotError('INVALID_INPUT', { evidenceId, field: 'counts' });
  if (evidence.status === 'passed' && (collected === 0 || failed !== 0)) {
    throw new SourceSnapshotError('INVALID_INPUT', { evidenceId, field: 'status' });
  }
  const environment = normalizeEnvironment(evidence.environment);
  const refs = normalizeArtifactRefs(evidence.artifactRefs);
  const provided = providedArtifactMap(artifacts);
  for (const ref of refs) {
    const bytes = provided.get(ref.artifactId) ?? mismatch({ evidenceId, field: 'artifact', artifactId: ref.artifactId });
    const integrity = await calculateBytesIntegrity(bytes);
    if (integrity.sha256 !== ref.sha256 || integrity.byteLength !== ref.byteLength) {
      mismatch({ evidenceId, field: 'artifact', artifactId: ref.artifactId });
    }
  }
  if (provided.size !== refs.length) throw new SourceSnapshotError('INVALID_INPUT', { evidenceId, field: 'artifacts', reason: 'unexpected-artifact' });
  return Object.freeze({
    schemaVersion: 1 as const,
    snapshotId: manifest.snapshotId,
    evidenceId,
    producer,
    producerVersion,
    schemaStatus: 'schema-valid' as const,
    sourceStatus: 'source-bound' as const,
    kind: evidence.kind,
    status: evidence.status,
    collected, passed, failed, skipped,
    ...(environment === undefined ? {} : { environment }),
    artifactCount: refs.length,
    artifacts: refs,
  });
};
