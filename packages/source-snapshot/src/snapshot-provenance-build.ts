import type { SnapshotManifest } from './contracts.js';
import type { ProvenanceOptions, SnapshotProvenance } from './snapshot-provenance-contracts.js';
import { createSnapshotManifest } from './manifest.js';
import { SourceSnapshotError } from './errors.js';
import { catalogHash, catalogJson } from './read-catalog-codec.js';
import { verifySnapshotReadCatalog } from './read-catalog-verify.js';
import { provenanceDigest, provenanceGroupsDigest, provenanceInvalid, provenanceMismatch, provenanceProducer, provenanceStates } from './snapshot-provenance-input.js';
/** 只绑定显式记录与已发布身份；不读取源树，不补写旧快照历史。 */
export const buildSnapshotProvenance = async (input: SnapshotManifest, options: ProvenanceOptions = {}): Promise<SnapshotProvenance> => {
  const maxEntries = options.maxEntries ?? 200000; const maxBytes = options.maxBytes ?? 67108864;
  for (const limit of [maxEntries, maxBytes]) if (!Number.isSafeInteger(limit) || limit <= 0) provenanceInvalid('provenance-budget');
  if (input.schemaVersion !== 1) provenanceInvalid('manifest-schema');
  if (input.files.length > maxEntries || (options.capture?.fileStates.length ?? 0) > maxEntries) throw new SourceSnapshotError('TEXT_READ_LIMIT_EXCEEDED', { field: 'provenance-entries' });
  const supplied = structuredClone(options); const originalId = input.snapshotId;
  const manifest = await createSnapshotManifest(structuredClone(input));
  if (manifest.snapshotId !== originalId) throw new SourceSnapshotError('SNAPSHOT_ID_MISMATCH');
  const manifestDigest = await catalogHash(catalogJson(manifest)); const groups = await provenanceGroupsDigest(manifest);
  const capture = supplied.capture;
  if (capture && (capture.snapshotId !== originalId || capture.manifestDigest !== manifestDigest || capture.policy.version !== manifest.policyVersion || capture.groupDecisionsDigest !== groups)) provenanceMismatch('capture-binding');
  if (capture && !['supplied-records', 'same-operation'].includes(capture.evidence)) provenanceInvalid('capture-evidence');
  const states = capture ? provenanceStates(manifest, capture) : null;
  const exporter = provenanceProducer(capture?.exporter); const grouping = provenanceProducer(capture?.grouping);
  const policy = capture ? Object.freeze({ version: capture.policy.version, effectiveDigest: provenanceDigest(capture.policy.effectiveDigest, 'policyDigest') }) : null;
  let coverageDigest: string | null = null; let catalogDigest: string | null = null;
  if (supplied.coverage) {
    const coverage = supplied.coverage;
    if (coverage.schemaVersion !== 1 || coverage.kind !== 'source-snapshot-coverage' || coverage.mode !== 'observation-only' || coverage.bodyVerification !== 'not-performed' || coverage.snapshotId !== originalId || coverage.manifestDigest !== manifestDigest) provenanceMismatch('coverage-binding');
    const entries = new Map(coverage.entries.filter(e => e.physical === 'full-text').map(e => [e.path, e]));
    if (entries.size !== manifest.files.length || coverage.entries.filter(e => e.physical === 'full-text').length !== entries.size) provenanceMismatch('coverage-files');
    for (const file of manifest.files) {
      const entry = entries.get(file.path);
      if (entry?.sourceSha256 !== file.sha256 || entry.sourceByteLength !== file.byteLength || entry.state !== 'full-text') provenanceMismatch('coverage-source');
    }
    coverageDigest = await catalogHash(catalogJson(coverage));
  }
  if (supplied.catalog) { await verifySnapshotReadCatalog(manifest, supplied.catalog); catalogDigest = supplied.catalog.root.sha256; }
  const frozenInputDigest = capture ? await catalogHash(catalogJson({ snapshotId: originalId, manifestDigest, policy, grouping,
    groupDecisionsDigest: groups, fileStates: states, repositories: manifest.repositories })) : null;
  const report: SnapshotProvenance = Object.freeze({ schemaVersion: 1, kind: 'source-snapshot-provenance', snapshotId: originalId, manifestDigest,
    origin: capture ? 'capture-records' : 'manifest-only', captureMode: capture ? 'working-tree' : 'unknown',
    captureEvidence: capture?.evidence ?? 'unknown', atomicity: capture ? 'not-guaranteed' : 'unknown',
    exporter, grouping, policy, reproducibility: grouping?.configDigest && exporter ? 'caller-declared' : 'unknown',
    groupDecisionsDigest: groups, frozenInputDigest, fileStates: states,
    repositories: Object.freeze(manifest.repositories.map(r => Object.freeze({ ...r }))), repositoryEvidence: capture ? 'capture-records' : 'manifest-declaration',
    derived: Object.freeze({ coverageDigest, catalogDigest }), bodyVerification: 'not-performed' });
  const content = catalogJson(report);
  if (content.length > maxBytes || new TextEncoder().encode(content).byteLength > maxBytes) throw new SourceSnapshotError('TEXT_READ_LIMIT_EXCEEDED', { field: 'provenance-bytes' });
  return report;
};
