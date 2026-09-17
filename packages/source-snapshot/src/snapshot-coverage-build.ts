import type { SnapshotManifest } from './contracts.js';
import type { CoverageEntry, CoverageState, SnapshotCoverageOptions, SnapshotCoverageReport } from './snapshot-coverage-contracts.js';
import { createSnapshotManifest } from './manifest.js';
import { SourceSnapshotError } from './errors.js';
import { compareStrings } from './validation.js';
import { catalogHash, catalogJson } from './read-catalog-codec.js';
import { captureCoverageOptions, coverageInvalid, coverageLimit, coverageStates } from './snapshot-coverage-input.js';
const physical = (state: CoverageState): CoverageEntry['physical'] => state === 'full-text' ? 'full-text'
  : state === 'metadata-only' || state === 'lfs-pointer-only' ? 'metadata-only'
  : state === 'policy-excluded' ? 'excluded' : state === 'unknown' ? 'unknown' : 'blocked';
/** 只从已提供的清单与决策派生观察报告；不读取文件、不改变纳入策略。 */
export const buildSnapshotCoverage = async (input: SnapshotManifest | null, options: SnapshotCoverageOptions = {}): Promise<SnapshotCoverageReport> => {
  const captured = captureCoverageOptions(options, input?.files.length ?? 0); const snapshotId = input?.snapshotId ?? null;
  if (input !== null && input.schemaVersion !== 1) coverageInvalid('manifest-schema');
  if (captured.profile !== null && captured.profile.snapshotId !== snapshotId) throw new SourceSnapshotError('ANALYSIS_SOURCE_MISMATCH', { field: 'snapshotId' });
  const manifest = input === null ? null : await createSnapshotManifest(input);
  if (manifest !== null && manifest.snapshotId !== snapshotId) throw new SourceSnapshotError('SNAPSHOT_ID_MISMATCH');
  const manifestDigest = manifest === null ? null : await catalogHash(catalogJson(manifest));
  const files = new Map(manifest?.files.map(file => [file.path, file]));
  const decisions = new Map(captured.decisions.map(value => [value.path, value]));
  const redacted = new Set(captured.decisions.filter(value => value.visibility === 'redacted').map(value => value.path));
  const hidden = (path: string): boolean => {
    let prefix = path; while (prefix.length > 0) { if (redacted.has(prefix)) return true; const slash = prefix.lastIndexOf('/'); if (slash < 0) break; prefix = prefix.slice(0, slash); } return false;
  };
  for (const path of files.keys()) if (hidden(path)) coverageInvalid('redacted-stored-text');
  const preferred = new Set(captured.profile?.preferredPaths); const reference = new Set(captured.profile?.referencePaths);
  const required = new Set(captured.requiredPaths); const entries: CoverageEntry[] = [];
  let accountedBytes = 0;
  for (const path of [...new Set([...files.keys(), ...decisions.keys()])].sort(compareStrings)) {
    if (hidden(path)) continue;
    const file = files.get(path); const decision = decisions.get(path); const state = decision?.state ?? (file ? 'full-text' : 'unknown');
    if ((state === 'full-text' && !file) || (file && !['full-text', 'lfs-pointer-only'].includes(state))) coverageInvalid('physical-manifest-conflict');
    const entry: CoverageEntry = Object.freeze({ path, state, physical: physical(state),
      priority: preferred.has(path) ? 'preferred' : reference.has(path) ? 'reference' : 'unclassified',
      role: captured.roleByPath.get(path) ?? null, rule: decision?.rule ?? null,
      sourceByteLength: file?.byteLength ?? decision?.byteLength ?? null, sourceSha256: file?.sha256 ?? null });
    accountedBytes += new TextEncoder().encode(catalogJson(entry)).byteLength;
    if (accountedBytes > captured.maxBytes) coverageLimit('coverage-bytes'); entries.push(entry);
    if (state === 'full-text') required.delete(path);
  }
  if (required.size !== 0) coverageInvalid('required-text-missing');
  const byPath = new Map(entries.map(entry => [entry.path, entry]));
  for (const path of captured.roleByPath.keys()) if (!byPath.has(path) && !hidden(path)) coverageInvalid('role-path');
  const redactedCandidates = new Set([...files.keys(), ...decisions.keys()].filter(hidden)).size;
  if (captured.candidateCount !== null && captured.candidateCount !== entries.length + redactedCandidates) coverageInvalid('candidate-count');
  const states = Object.fromEntries(coverageStates.map(state => [state, 0])) as Record<CoverageState, number>;
  for (const entry of entries) states[entry.state] += 1;
  const sum = (values: readonly { readonly byteLength: number }[]) => {
    let total = 0; for (const value of values) { total += value.byteLength; if (!Number.isSafeInteger(total)) coverageInvalid('byte-sum'); } return total;
  };
  const boundaries = Object.freeze(captured.boundaries.filter(value => !hidden(value.prefix)));
  const report: SnapshotCoverageReport = Object.freeze({ schemaVersion: 1, kind: 'source-snapshot-coverage', mode: 'observation-only',
    snapshotId, manifestDigest, bodyVerification: 'not-performed', profileId: captured.profile?.profileId ?? null,
    entries: Object.freeze(entries), boundaries, summary: Object.freeze({ enumeratedCandidates: captured.candidateCount,
      reportedEntries: entries.length, redactedCandidates, fullTextFiles: states['full-text'],
      logicalSourceBytes: sum(manifest?.files ?? []), objectContainerBytes: sum(manifest?.objects ?? []), states: Object.freeze(states),
      unenumeratedBoundaryCount: boundaries.filter(value => value.state !== 'complete' || value.inventory !== 'all-paths').length,
      unresolvedProfilePaths: Object.freeze([...new Set([...preferred, ...reference])].filter(path => !byPath.has(path) && !hidden(path)).sort(compareStrings)),
      duplicateProfilePaths: Object.freeze(captured.duplicateProfilePaths.filter(path => !hidden(path))),
      largestEntries: Object.freeze(entries.filter(entry => entry.sourceByteLength !== null).sort((a, b) => (b.sourceByteLength ?? 0) - (a.sourceByteLength ?? 0) || compareStrings(a.path, b.path)).slice(0, captured.topCount).map(entry => Object.freeze({ path: entry.path, sourceByteLength: entry.sourceByteLength ?? 0, state: entry.state }))) }) });
  if (new TextEncoder().encode(catalogJson(report)).byteLength > captured.maxBytes) coverageLimit('coverage-bytes'); return report;
};
