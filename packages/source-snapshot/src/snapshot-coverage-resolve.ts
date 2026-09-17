import type { SnapshotManifest } from './contracts.js';
import type { CoverageResolution, SnapshotCoverageReport, SnapshotCoverageOptions } from './snapshot-coverage-contracts.js';
import { buildSnapshotCoverage } from './snapshot-coverage-build.js';
import { coverageInvalid, coveragePath } from './snapshot-coverage-input.js';
import { catalogHash, catalogJson } from './read-catalog-codec.js';
import { SourceSnapshotError } from './errors.js';
/** 持久化报告应先全量绑定校验；该查询不证明当前工作树状态或正文 I/O。 */
export const resolveSnapshotCoverage = (report: SnapshotCoverageReport, path: string): CoverageResolution => {
  if (report.schemaVersion !== 1 || report.kind !== 'source-snapshot-coverage') coverageInvalid('coverage-schema'); coveragePath(path);
  const entry = report.entries.find(value => value.path === path);
  if (entry) return Object.freeze({ path, state: entry.state, fullTextAvailable: entry.state === 'full-text', sourceExistence: 'unknown', entry });
  const boundary = report.boundaries.filter(value => value.prefix === '' || path === value.prefix || path.startsWith(`${value.prefix}/`)).sort((a, b) => b.prefix.length - a.prefix.length)[0];
  if (boundary?.state === 'complete' && boundary.inventory === 'all-paths' && boundary.evidenceSha256 && report.summary.redactedCandidates === 0) {
    return Object.freeze({ path, state: 'not-exists', fullTextAvailable: false, sourceExistence: 'absent' });
  }
  return Object.freeze({ path, state: boundary?.state === 'complete' ? 'unknown' : boundary?.state ?? 'unknown', fullTextAvailable: false, sourceExistence: 'unknown' });
};
export const verifySnapshotCoverage = async (manifest: SnapshotManifest | null, options: SnapshotCoverageOptions, report: SnapshotCoverageReport) => {
  const actual = catalogJson(report); const expected = await buildSnapshotCoverage(manifest, options);
  if (actual !== catalogJson(expected)) throw new SourceSnapshotError('ANALYSIS_SOURCE_MISMATCH', { field: 'coverage' });
  return Object.freeze({ scope: 'manifest-and-coverage' as const, snapshotId: expected.snapshotId, manifestDigest: expected.manifestDigest,
    coverageDigest: await catalogHash(actual), bodyVerification: 'not-performed' as const });
};
