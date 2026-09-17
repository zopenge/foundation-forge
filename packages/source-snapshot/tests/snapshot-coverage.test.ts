import { expect, test } from 'vitest';
import { buildSourceTextPackage, createTextSnapshotManifest, stageSourceTextFile } from '../src/index.js';
import { buildSnapshotCoverage, resolveSnapshotCoverage, verifySnapshotCoverage } from '../src/snapshot-coverage.js';
const rule = { ruleId: 'explicit-selection', ruleVersion: '1', producer: 'test-consumer', configDigest: 'a'.repeat(64) };
async function fixture() {
  const paths = ['src/main.ts', 'schema/model.json', 'types/model.d.ts', 'examples/demo.ts', 'libs/custom.ts'];
  const staged = await Promise.all(paths.map(path => stageSourceTextFile({ path, group: 'code', bytes: new TextEncoder().encode('export const value = 1;\n') })));
  const textPackage = await buildSourceTextPackage(staged, { targetObjectBytes: 4096, maxObjectBytes: 8192, maxObjectCount: 10, maxObjectBytesTotal: 100000, textFormatVersion: 2 });
  return createTextSnapshotManifest({ projectId: 'coverage-fixture', policyVersion: '1', publishedAt: 1, repositories: [], textPackage });
}
test('observation preserves necessary text independently of reference priority and role', async () => {
  const manifest = await fixture();
  const options = { requiredPaths: manifest.files.map(file => file.path), profile: { profileId: 'review', snapshotId: manifest.snapshotId, preferredPaths: ['src/main.ts'], referencePaths: ['schema/model.json'] }, roles: [{ path: 'schema/model.json', role: 'schema' }] };
  const before = JSON.stringify(manifest); const report = await buildSnapshotCoverage(manifest, options);
  expect(report.mode).toBe('observation-only'); expect(report.bodyVerification).toBe('not-performed');
  expect(report.summary.fullTextFiles).toBe(5); expect(report.summary.enumeratedCandidates).toBeNull();
  expect(report.entries.find(entry => entry.path === 'schema/model.json')).toMatchObject({ state: 'full-text', physical: 'full-text', priority: 'reference', role: 'schema' });
  expect(JSON.stringify(manifest)).toBe(before);
  expect(await verifySnapshotCoverage(manifest, options, report)).toMatchObject({ scope: 'manifest-and-coverage', bodyVerification: 'not-performed' });
});
test('reports explicit omitted states without claiming their full text is stored', async () => {
  const manifest = await fixture();
  const report = await buildSnapshotCoverage(manifest, { decisions: [
    { path: 'data/large.json', state: 'metadata-only', rule }, { path: 'cache/build.js', state: 'policy-excluded', rule },
    { path: 'binary/input.dat', state: 'unsupported-decoding', rule }, { path: 'failed/input.ts', state: 'capture-failed', rule },
    { path: 'new/unknown.ext', state: 'pending-review', rule }, { path: 'model.asset', state: 'lfs-pointer-only', rule },
  ] });
  for (const path of ['data/large.json', 'cache/build.js', 'binary/input.dat', 'failed/input.ts', 'new/unknown.ext', 'model.asset']) expect(resolveSnapshotCoverage(report, path).fullTextAvailable).toBe(false);
});
test('absence is unknown unless the exact scope has complete all-paths evidence', async () => {
  const manifest = await fixture();
  const report = await buildSnapshotCoverage(manifest, { boundaries: [
    { prefix: 'complete', state: 'complete', inventory: 'all-paths', evidenceSha256: 'b'.repeat(64) },
    { prefix: 'git-only', state: 'complete', inventory: 'git-listed', evidenceSha256: 'b'.repeat(64) },
    { prefix: 'vendor/sub', state: 'submodule-uninitialized', inventory: 'unknown' },
  ] });
  expect(resolveSnapshotCoverage(report, 'complete/missing.ts').sourceExistence).toBe('absent');
  expect(resolveSnapshotCoverage(report, 'git-only/ignored.ts').sourceExistence).toBe('unknown');
  expect(resolveSnapshotCoverage(report, 'complete-other/missing.ts').sourceExistence).toBe('unknown');
  expect(resolveSnapshotCoverage(report, 'vendor/sub/file.ts').state).toBe('submodule-uninitialized');
  expect(resolveSnapshotCoverage(report, 'outside.ts').state).toBe('unknown');
});
test('redacted candidates reveal neither paths nor rules and cannot be overridden by profile', async () => {
  const manifest = await fixture();
  const report = await buildSnapshotCoverage(manifest, { decisions: [{ path: '.private-secret', state: 'policy-excluded', visibility: 'redacted', rule }],
    boundaries: [{ prefix: '', state: 'complete', inventory: 'all-paths', evidenceSha256: 'b'.repeat(64) }] });
  expect(JSON.stringify(report)).not.toContain('.private-secret'); expect(report.summary.redactedCandidates).toBe(1);
  expect(resolveSnapshotCoverage(report, '.private-secret').sourceExistence).toBe('unknown');
  await expect(buildSnapshotCoverage(manifest, { decisions: [{ path: 'src/main.ts', state: 'policy-excluded', visibility: 'redacted', rule }] })).rejects.toMatchObject({ code: 'COVERAGE_INVALID' });
});
test('rejects invented full text, exclusions of stored text and loss of required paths', async () => {
  const manifest = await fixture();
  await expect(buildSnapshotCoverage(manifest, { decisions: [{ path: 'not-stored.ts', state: 'full-text', rule }] })).rejects.toMatchObject({ code: 'COVERAGE_INVALID' });
  await expect(buildSnapshotCoverage(manifest, { decisions: [{ path: 'src/main.ts', state: 'metadata-only', rule }] })).rejects.toMatchObject({ code: 'COVERAGE_INVALID' });
  await expect(buildSnapshotCoverage(manifest, { requiredPaths: ['absent-schema.json'] })).rejects.toMatchObject({ code: 'COVERAGE_INVALID' });
});
test('rejects malformed scope, duplicate paths, source mismatch and bounded report overflow', async () => {
  const manifest = await fixture();
  await expect(buildSnapshotCoverage(manifest, { boundaries: [{ prefix: '../escape', state: 'unknown', inventory: 'unknown' }] })).rejects.toBeDefined();
  await expect(buildSnapshotCoverage(manifest, { boundaries: [{ prefix: '', state: 'complete', inventory: 'all-paths' }] })).rejects.toMatchObject({ code: 'COVERAGE_INVALID' });
  await expect(buildSnapshotCoverage(manifest, { decisions: [{ path: 'a', state: 'unknown' }, { path: 'a', state: 'unknown' }] })).rejects.toMatchObject({ code: 'COVERAGE_INVALID' });
  await expect(buildSnapshotCoverage(manifest, { profile: { profileId: 'wrong', snapshotId: 'wrong', preferredPaths: [], referencePaths: [] } })).rejects.toMatchObject({ code: 'ANALYSIS_SOURCE_MISMATCH' });
  await expect(buildSnapshotCoverage(manifest, { maxEntries: 1 })).rejects.toMatchObject({ code: 'TEXT_READ_LIMIT_EXCEEDED' });
  await expect(buildSnapshotCoverage(manifest, { maxBytes: 100 })).rejects.toMatchObject({ code: 'TEXT_READ_LIMIT_EXCEEDED' });
});
test('canonical report is deterministic, immutable and verifies against its complete input', async () => {
  const manifest = await fixture(); const first = await buildSnapshotCoverage(manifest);
  expect(await buildSnapshotCoverage(manifest)).toEqual(first); expect(Object.isFrozen(first.entries)).toBe(true);
  expect(Object.isFrozen(first.entries[0])).toBe(true);
  await expect(verifySnapshotCoverage(manifest, {}, { ...first, snapshotId: 'wrong' })).rejects.toMatchObject({ code: 'ANALYSIS_SOURCE_MISMATCH' });
  expect(first.summary.logicalSourceBytes).toBe(manifest.files.reduce((sum, file) => sum + file.byteLength, 0));
});
test('blocked capture can explain candidates without inventing a published snapshot', async () => {
  const report = await buildSnapshotCoverage(null, { decisions: [{ path: 'src/failed.ts', state: 'capture-failed', rule }],
    candidateCount: 1, boundaries: [{ prefix: '', state: 'unknown', inventory: 'git-listed' }] });
  expect(report.snapshotId).toBeNull(); expect(report.manifestDigest).toBeNull();
  expect(report.summary.enumeratedCandidates).toBe(1); expect(report.summary.fullTextFiles).toBe(0);
});
test('manifest-only reports retain an explicit unknown discovery boundary', async () => {
  const report = await buildSnapshotCoverage(await fixture());
  expect(report.boundaries).toContainEqual({ prefix: '', state: 'unknown', inventory: 'unknown' });
  expect(report.summary.unenumeratedBoundaryCount).toBeGreaterThan(0);
});
test('redaction also covers profile duplicates, roles and exact boundary names', async () => {
  const manifest = await fixture(); const hidden = 'private/file.key';
  const report = await buildSnapshotCoverage(manifest, { decisions: [{ path: hidden, state: 'unknown', visibility: 'redacted' }], roles: [{ path: hidden, role: 'hidden' }],
    profile: { profileId: 'review', snapshotId: manifest.snapshotId, preferredPaths: [hidden], referencePaths: [hidden] },
    boundaries: [{ prefix: hidden, state: 'outside-discovery', inventory: 'unknown' }] });
  expect(JSON.stringify(report)).not.toContain(hidden); expect(report.summary.duplicateProfilePaths).toEqual([]);
});
