import type { SnapshotManifest } from './contracts.js';
import type { ProvenanceOptions, SnapshotProvenance } from './snapshot-provenance-contracts.js';
import { buildSnapshotProvenance } from './snapshot-provenance-build.js';
import { validateSnapshotEvidence } from './analysis-metadata.js';
import { catalogHash, catalogJson } from './read-catalog-codec.js';
import { provenanceMismatch } from './snapshot-provenance-input.js';
/** 复用 detached evidence 的来源/字节绑定；不证明采集声明可信或正文已验证。 */
export const verifySnapshotProvenance = async (manifest: SnapshotManifest, options: ProvenanceOptions, input: SnapshotProvenance) => {
  const report = structuredClone(input); const content = catalogJson(report);
  const expected = await buildSnapshotProvenance(manifest, options);
  if (content !== catalogJson(expected)) provenanceMismatch('provenance-report');
  const bytes = new TextEncoder().encode(content); const sha256 = await catalogHash(content);
  const validation = await validateSnapshotEvidence(manifest, { evidenceId: 'provenance-binding', snapshotId: expected.snapshotId,
    producer: 'source-snapshot', producerVersion: 'provenance-v1', kind: 'static', status: 'passed', collected: 1, passed: 1, failed: 0, skipped: 0,
    artifactRefs: [{ artifactId: 'provenance', sha256, byteLength: bytes.byteLength }] }, [{ artifactId: 'provenance', bytes }]);
  return Object.freeze({ scope: 'manifest-and-provenance' as const, snapshotId: expected.snapshotId, manifestDigest: expected.manifestDigest,
    provenanceDigest: sha256, schemaStatus: validation.schemaStatus, sourceStatus: validation.sourceStatus,
    bodyVerification: 'not-performed' as const, originAuthenticated: false as const });
};
