import { validatePortableRelativePath } from '@openge/forge-path-safety';
import type { SnapshotCoverageOptions, CoverageState, CoverageRule, CoverageDecision, CoverageBoundary } from './snapshot-coverage-contracts.js';
import { SourceSnapshotError } from './errors.js';
import { compareStrings } from './validation.js';
export const coverageInvalid = (field: string): never => { throw new SourceSnapshotError('COVERAGE_INVALID', { field }); };
export const coverageLimit = (field: string): never => { throw new SourceSnapshotError('TEXT_READ_LIMIT_EXCEEDED', { field }); };
export const coveragePath = (path: string): string => {
  if (typeof path !== 'string' || path.length > 4096) return coverageInvalid('path');
  try { return validatePortableRelativePath(path); } catch { return coverageInvalid('path'); }
};
export const coverageCount = (value: number, field: string): number => Number.isSafeInteger(value) && value >= 0 ? value : coverageInvalid(field);
const identifier = (value: string): string => typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/u.test(value) ? value : coverageInvalid('identifier');
const digest = (value: string): string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) ? value : coverageInvalid('digest');
export const coverageStates: readonly CoverageState[] = Object.freeze(['full-text', 'metadata-only', 'policy-excluded', 'pending-review', 'unsupported-decoding', 'capture-failed', 'lfs-pointer-only', 'unknown']);
const rule = (value: CoverageRule): CoverageRule => Object.freeze({ ruleId: identifier(value.ruleId), ruleVersion: identifier(value.ruleVersion), producer: identifier(value.producer), configDigest: digest(value.configDigest) });
const paths = (values: readonly string[]) => Object.freeze([...new Set(values.map(coveragePath))].sort(compareStrings));
export const captureCoverageOptions = (input: SnapshotCoverageOptions, fileCount: number) => {
  const maxEntries = input.maxEntries ?? 200000; const maxBytes = input.maxBytes ?? 67108864; const topCount = input.topCount ?? 20;
  if (coverageCount(maxEntries, 'maxEntries') < 1 || maxEntries > 1000000 || coverageCount(maxBytes, 'maxBytes') < 1 || maxBytes > 134217728 || coverageCount(topCount, 'topCount') > 100) coverageInvalid('limits');
  const decisions = input.decisions ?? []; const boundaries = input.boundaries ?? [];
  const roles = input.roles ?? []; const required = input.requiredPaths ?? [];
  const preferred = input.profile?.preferredPaths ?? []; const reference = input.profile?.referencePaths ?? [];
  for (const values of [decisions, boundaries, roles, required, preferred, reference]) if (!Array.isArray(values)) coverageInvalid('array');
  if (fileCount + decisions.length + boundaries.length + roles.length + required.length + preferred.length + reference.length > maxEntries) coverageLimit('coverage-entries');
  const seen = new Set<string>();
  const capturedDecisions: readonly CoverageDecision[] = Object.freeze(decisions.map(value => {
    const path = coveragePath(value.path);
    if (seen.has(path) || !coverageStates.includes(value.state)) coverageInvalid('decision'); seen.add(path);
    if (value.visibility !== undefined && value.visibility !== 'public' && value.visibility !== 'redacted') coverageInvalid('visibility');
    if (value.visibility === 'redacted') return Object.freeze({ path, state: value.state, visibility: 'redacted' as const });
    if (value.state !== 'unknown' && value.state !== 'full-text' && value.rule === undefined) coverageInvalid('decision-rule');
    return Object.freeze({ path, state: value.state, visibility: 'public' as const,
      ...(value.rule === undefined ? {} : { rule: rule(value.rule) }),
      byteLength: value.byteLength === undefined || value.byteLength === null ? null : coverageCount(value.byteLength, 'byteLength') });
  }));
  const boundaryPrefixes = new Set<string>();
  const scopedBoundaries: readonly CoverageBoundary[] = boundaries.some(value => value.prefix === '') ? boundaries : [{ prefix: '', state: 'unknown', inventory: 'unknown' }, ...boundaries];
  const capturedBoundaries: readonly CoverageBoundary[] = Object.freeze(scopedBoundaries.map(value => {
    const prefix = value.prefix === '' ? '' : coveragePath(value.prefix);
    if (boundaryPrefixes.has(prefix)) coverageInvalid('boundary-duplicate'); boundaryPrefixes.add(prefix);
    if (!['complete', 'outside-discovery', 'policy-excluded', 'submodule-uninitialized', 'capture-failed', 'unknown'].includes(value.state) || !['all-paths', 'git-listed', 'unknown'].includes(value.inventory)) coverageInvalid('boundary');
    if (value.state === 'complete' && value.evidenceSha256 === undefined) coverageInvalid('complete-evidence');
    return Object.freeze({ prefix, state: value.state, inventory: value.inventory,
      ...(value.evidenceSha256 === undefined ? {} : { evidenceSha256: digest(value.evidenceSha256) }) });
  }).sort((a, b) => compareStrings(a.prefix, b.prefix)));
  const roleByPath = new Map<string, string>();
  for (const value of roles) {
    const path = coveragePath(value.path); if (roleByPath.has(path)) coverageInvalid('role-duplicate');
    roleByPath.set(path, identifier(value.role));
  }
  const profile = input.profile === undefined ? null : Object.freeze({ profileId: identifier(input.profile.profileId), snapshotId: input.profile.snapshotId,
    preferredPaths: paths(preferred), referencePaths: paths(reference) });
  const counts = new Map<string, number>();
  for (const path of [...preferred, ...reference]) counts.set(path, (counts.get(path) ?? 0) + 1);
  const duplicates = Object.freeze([...counts].filter(([, count]) => count > 1).map(([path]) => path).sort(compareStrings));
  return { maxEntries, maxBytes, topCount, decisions: capturedDecisions, boundaries: capturedBoundaries, roleByPath,
    profile, duplicateProfilePaths: duplicates, requiredPaths: paths(required),
    candidateCount: input.candidateCount === undefined ? null : coverageCount(input.candidateCount, 'candidateCount') };
};
