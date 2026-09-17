import { SourceSnapshotError } from '../errors.js';
import type { RepositorySnapshotPlan } from './contracts.js';
import type { PreparedRepositorySnapshotPlan } from './prepared-pipeline.js';
import type { ProvenanceProducer } from '../snapshot-provenance-contracts.js';
import type { CoverageCaptureOptions } from './snapshot-coverage.js';
import { buildSnapshotCoverageFromPlan } from './snapshot-coverage.js';
import { buildSnapshotReadCatalog } from '../read-catalog-build.js';
import { buildSnapshotProvenance } from '../snapshot-provenance-build.js';
import { verifySnapshotProvenance } from '../snapshot-provenance-verify.js';
import { provenanceGroupsDigest, provenanceMismatch, provenanceProducer } from '../snapshot-provenance-input.js';
import { defineSourceSnapshotPolicy } from '../policy.js';
import { catalogHash, catalogJson } from '../read-catalog-codec.js';
export interface ProvenanceCaptureOptions extends Omit<CoverageCaptureOptions, 'producer'> {
  readonly exporter?: ProvenanceProducer; readonly grouping?: ProvenanceProducer;
}
/** 只投影已冻结记录；旧 manifest 没有的历史状态不能通过本入口猜测。 */
export const buildSnapshotProvenanceFromPlan = async (
  input: PreparedRepositorySnapshotPlan | RepositorySnapshotPlan, options: ProvenanceCaptureOptions,
  evidence: 'supplied-records' | 'same-operation' = 'supplied-records',
) => {
  const capturedOptions = structuredClone(options);
  provenanceProducer(capturedOptions.exporter); provenanceProducer(capturedOptions.grouping);
  if (input.inventory.entries.length > (capturedOptions.display?.maxEntries ?? 200000)) throw new SourceSnapshotError('TEXT_READ_LIMIT_EXCEEDED', { field: 'provenance-entries' });
  const plan = structuredClone({ status: input.status, publishAllowed: input.publishAllowed, inventory: input.inventory,
    decisions: input.decisions, includedPaths: input.includedPaths, reviewEntries: input.reviewEntries,
    secretFindings: input.secretFindings, contentIssues: input.contentIssues, freeze: input.freeze,
    manifest: 'manifest' in input ? input.manifest : input.bundle?.manifest ?? null });
  const manifest = plan.manifest ?? provenanceMismatch('published-manifest-required');
  const coverage = await buildSnapshotCoverageFromPlan(plan, { policy: capturedOptions.policy, policyVersion: capturedOptions.policyVersion,
    producer: capturedOptions.exporter?.id ?? 'unspecified-producer', ...(capturedOptions.display ? { display: capturedOptions.display } : {}) });
  const catalog = await buildSnapshotReadCatalog(manifest, capturedOptions.display?.profile ? { profile: capturedOptions.display.profile } : {});
  const entries = new Map(plan.inventory.entries.map(entry => [entry.projectPath, entry]));
  const fileStates = manifest.files.map(file => {
    const entry = entries.get(file.path) ?? provenanceMismatch('inventory-path');
    const status = entry.status ?? (entry.untracked ? '??' : '  ');
    return { path: file.path, sha256: file.sha256, tracked: entry.tracked, untracked: entry.untracked,
      indexStatus: status[0] ?? '', worktreeStatus: status[1] ?? '',
      staged: entry.tracked && status[0] !== ' ' && status[0] !== '?',
      worktreeModified: entry.tracked && status[1] !== ' ' && status[1] !== '?' };
  });
  const bindingOptions = { capture: { snapshotId: manifest.snapshotId, manifestDigest: await catalogHash(catalogJson(manifest)),
    ...(capturedOptions.exporter ? { exporter: capturedOptions.exporter } : {}), ...(capturedOptions.grouping ? { grouping: capturedOptions.grouping } : {}),
    policy: { version: capturedOptions.policyVersion, effectiveDigest: await catalogHash(catalogJson(defineSourceSnapshotPolicy(capturedOptions.policy))) },
    groupDecisionsDigest: await provenanceGroupsDigest(manifest), fileStates, evidence }, coverage, catalog,
    ...(capturedOptions.display?.maxEntries === undefined ? {} : { maxEntries: capturedOptions.display.maxEntries }),
    ...(capturedOptions.display?.maxBytes === undefined ? {} : { maxBytes: capturedOptions.display.maxBytes }) };
  const provenance = await buildSnapshotProvenance(manifest, bindingOptions);
  const verification = await verifySnapshotProvenance(manifest, bindingOptions, provenance);
  return Object.freeze({ provenance, coverage, catalog, verification });
};
