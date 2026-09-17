import { expect, test } from 'vitest';
import { buildSourceTextPackage, createTextSnapshotManifest, stageSourceTextFile } from '../src/index.js';
import { buildSnapshotProvenance, verifySnapshotProvenance } from '../src/snapshot-provenance.js';
async function fixture() {
  const textPackage = await buildSourceTextPackage([await stageSourceTextFile({ path: 'src/main.ts', group: 'code', bytes: new TextEncoder().encode('export const value = 1;\n') })],
    { targetObjectBytes: 4096, maxObjectBytes: 8192, maxObjectCount: 10, maxObjectBytesTotal: 100000, textFormatVersion: 2 });
  return createTextSnapshotManifest({ projectId: 'provenance', policyVersion: 'v1', publishedAt: 1, repositories: [], textPackage });
}
test('legacy snapshots preserve unknown capture provenance instead of backfilling current state', async () => {
  const manifest = await fixture(); const report = await buildSnapshotProvenance(manifest);
  expect(report).toMatchObject({ snapshotId: manifest.snapshotId, origin: 'manifest-only', captureMode: 'unknown',
    exporter: null, grouping: null, policy: null, frozenInputDigest: null, fileStates: null, bodyVerification: 'not-performed' });
  expect(await verifySnapshotProvenance(manifest, {}, report)).toMatchObject({ scope: 'manifest-and-provenance', sourceStatus: 'source-bound', bodyVerification: 'not-performed' });
});
test('provenance is deterministic, immutable and cannot validate a forged source or sidecar', async () => {
  const manifest = await fixture(); const a = await buildSnapshotProvenance(manifest); const b = await buildSnapshotProvenance(manifest);
  expect(a).toEqual(b); expect(Object.isFrozen(a)).toBe(true);
  await expect(buildSnapshotProvenance({ ...manifest, snapshotId: 'snapshot-' + 'f'.repeat(64) })).rejects.toMatchObject({ code: 'SNAPSHOT_ID_MISMATCH' });
  await expect(verifySnapshotProvenance(manifest, {}, { ...a, captureMode: 'working-tree' })).rejects.toMatchObject({ code: 'ANALYSIS_SOURCE_MISMATCH' });
});
test('unknown schemas and explicit report budgets fail closed without changing snapshot identity', async () => {
  const manifest = await fixture();
  await expect(buildSnapshotProvenance(JSON.parse(JSON.stringify({ ...manifest, schemaVersion: 2 })))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(buildSnapshotProvenance(manifest, { maxBytes: 8 })).rejects.toMatchObject({ code: 'TEXT_READ_LIMIT_EXCEEDED' });
  await expect(buildSnapshotProvenance(manifest, { maxEntries: 0 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});
test('derived coverage and catalog must bind the exact manifest and remain separately scoped', async () => {
  const manifest = await fixture();
  const { buildSnapshotCoverage } = await import('../src/snapshot-coverage.js');
  const { buildSnapshotReadCatalog } = await import('../src/read-catalog.js');
  const coverage = await buildSnapshotCoverage(manifest); const catalog = await buildSnapshotReadCatalog(manifest);
  const report = await buildSnapshotProvenance(manifest, { coverage, catalog });
  expect(report.derived.catalogDigest).toBe(catalog.root.sha256); expect(report.derived.coverageDigest).toMatch(/^[a-f0-9]{64}$/u);
  expect(report.captureEvidence).toBe('unknown'); expect(report.fileStates).toBeNull();
  await expect(buildSnapshotProvenance(manifest, { coverage: { ...coverage, manifestDigest: '0'.repeat(64) }, catalog }))
    .rejects.toMatchObject({ code: 'ANALYSIS_SOURCE_MISMATCH' });
  const tampered = { ...catalog, root: { ...catalog.root, content: catalog.root.content + ' ' } };
  await expect(buildSnapshotProvenance(manifest, { coverage, catalog: tampered })).rejects.toBeDefined();
});
