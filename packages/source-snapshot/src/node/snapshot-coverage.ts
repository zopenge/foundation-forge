import type { SourceSnapshotPolicyInput } from '../content-contracts.js';
import type { SnapshotCoverageOptions, SnapshotCoverageReport, CoverageDecision, CoverageBoundary, CoverageState } from '../snapshot-coverage-contracts.js';
import type { PreparedRepositorySnapshotPlan } from './prepared-pipeline.js';
import type { RepositorySnapshotPlan } from './contracts.js';
import { SourceSnapshotError } from '../errors.js';
import { buildSnapshotCoverage } from '../snapshot-coverage-build.js';
import { coverageInvalid, coverageLimit } from '../snapshot-coverage-input.js';
import { catalogHash, catalogJson } from '../read-catalog-codec.js';
import { classifySourcePath, defineSourceSnapshotPolicy } from '../policy.js';
import { calculateInventoryFingerprint, repositoryManifestInput } from './repository-state.js';
export interface CoverageCaptureOptions {
  readonly policy: SourceSnapshotPolicyInput; readonly policyVersion: string; readonly producer: string;
  readonly display?: Omit<SnapshotCoverageOptions, 'candidateCount' | 'decisions' | 'boundaries'>;
}
/** 接受已产生的冻结记录；不访问 sourceRoot，不重新发现或执行仓库内容。 */
export const buildSnapshotCoverageFromPlan = async (input: PreparedRepositorySnapshotPlan | RepositorySnapshotPlan, options: CoverageCaptureOptions): Promise<SnapshotCoverageReport> => {
  if (input.inventory.entries.length > (options.display?.maxEntries ?? 200000)) coverageLimit('coverage-candidates');
  const plan = structuredClone({ inventory: input.inventory, decisions: input.decisions, includedPaths: input.includedPaths,
    secretFindings: input.secretFindings, contentIssues: input.contentIssues, freeze: input.freeze, status: input.status, publishAllowed: input.publishAllowed,
    manifest: 'manifest' in input ? input.manifest : input.bundle?.manifest ?? null });
  const capturedOptions = structuredClone(options); const policy = defineSourceSnapshotPolicy(capturedOptions.policy);
  if (await calculateInventoryFingerprint(plan.inventory) !== plan.freeze.inventoryFingerprint) throw new SourceSnapshotError('SOURCE_CHANGED');
  if ((plan.status === 'READY') !== plan.publishAllowed || (plan.manifest !== null) !== plan.publishAllowed) coverageInvalid('plan-state');
  const decisions = new Map(plan.decisions.map(value => [value.path, value.decision]));
  const entries = new Map(plan.inventory.entries.map(value => [value.projectPath, value]));
  if (plan.publishAllowed && (plan.contentIssues.length > 0 || plan.secretFindings.length > 0 || plan.inventory.issues.length > 0 || plan.decisions.some(value => value.decision.action === 'review'))) coverageInvalid('ready-with-blockers');
  for (const issue of [...plan.contentIssues, ...plan.secretFindings]) if (issue.path !== '' && !entries.has(issue.path)) coverageInvalid('issue-path');
  if (decisions.size !== plan.decisions.length || entries.size !== plan.inventory.entries.length || decisions.size !== entries.size) coverageInvalid('capture-decisions');
  for (const entry of entries.values()) {
    const expected = classifySourcePath({ path: entry.projectPath, exists: entry.exists, type: entry.type }, policy);
    const observed = decisions.get(entry.projectPath);
    if (observed?.action !== expected.action || observed.ruleId !== expected.ruleId) throw new SourceSnapshotError('ANALYSIS_SOURCE_MISMATCH', { field: 'capture-policy' });
  }
  const frozen = new Map(plan.freeze.files.map(value => [value.path, value.sha256]));
  if (frozen.size !== plan.freeze.files.length || new Set(plan.includedPaths).size !== plan.includedPaths.length || frozen.size !== plan.includedPaths.length) coverageInvalid('frozen-files');
  for (const path of plan.includedPaths) if (!frozen.has(path) || !entries.has(path)) coverageInvalid('frozen-path');
  if (plan.manifest !== null) {
    if (plan.manifest.policyVersion !== capturedOptions.policyVersion || plan.manifest.files.length !== frozen.size) throw new SourceSnapshotError('ANALYSIS_SOURCE_MISMATCH', { field: 'capture-manifest' });
    for (const file of plan.manifest.files) if (frozen.get(file.path) !== file.sha256) throw new SourceSnapshotError('ANALYSIS_SOURCE_MISMATCH', { field: 'frozen-source' });
    const repositories = [...repositoryManifestInput(plan.inventory)].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    if (catalogJson(repositories) !== catalogJson(plan.manifest.repositories)) throw new SourceSnapshotError('ANALYSIS_SOURCE_MISMATCH', { field: 'repositories' });
  }
  const secretPaths = new Set(plan.secretFindings.map(value => value.path));
  const issues = new Map(plan.contentIssues.map(value => [value.path, value.code]));
  const stored = new Set(plan.manifest?.files.map(value => value.path));
  const stamp = { ruleVersion: capturedOptions.policyVersion, producer: capturedOptions.producer, configDigest: await catalogHash(catalogJson(policy)) };
  const coverage: CoverageDecision[] = [];
  for (const entry of entries.values()) {
    const decision = decisions.get(entry.projectPath) ?? coverageInvalid('capture-decision-missing');
    if (decision.ruleId === 'sensitive-path' || secretPaths.has(entry.projectPath)) {
      coverage.push({ path: entry.projectPath, state: 'policy-excluded', visibility: 'redacted' }); continue;
    }
    const issue = issues.get(entry.projectPath); let state: CoverageState; let ruleId = decision.ruleId;
    if (issue) { state = ['INVALID_TEXT_ENCODING', 'BINARY_CONTENT'].includes(issue) ? 'unsupported-decoding' : 'capture-failed'; ruleId = state; }
    else if (decision.action === 'exclude') state = 'policy-excluded';
    else if (decision.action === 'review') state = 'pending-review';
    else if (stored.has(entry.projectPath)) state = 'full-text';
    else if (frozen.has(entry.projectPath)) { state = 'metadata-only'; ruleId = 'publication-blocked'; }
    else { state = 'unknown'; ruleId = 'capture-not-established'; }
    coverage.push({ path: entry.projectPath, state, byteLength: entry.exists ? entry.size : null, rule: { ...stamp, ruleId } });
  }
  const boundaries = new Map<string, CoverageBoundary>([['', { prefix: '', state: 'unknown', inventory: 'git-listed' }]]);
  for (const issue of plan.inventory.issues) {
    boundaries.set(issue.path, { prefix: issue.path, state: issue.code === 'SUBMODULE_UNINITIALIZED' ? 'submodule-uninitialized' : 'capture-failed', inventory: 'unknown' });
  }
  return buildSnapshotCoverage(plan.manifest, { ...capturedOptions.display, decisions: coverage,
    candidateCount: plan.inventory.entries.length, boundaries: [...boundaries.values()] });
};
