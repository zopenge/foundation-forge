import { readFile } from 'node:fs/promises';
import { calculateBytesIntegrity } from '@openge/forge-artifact-integrity';
import { stringifyDeterministicJson } from '@openge/forge-deterministic-json';
import {
  buildSourceTextPackage,
  classifySourcePath,
  createTextSnapshotManifest,
  defineSourceSnapshotPolicy,
  scanSourceSecrets,
  stageSourceTextFile,
} from '../index.js';
import type { SourceSnapshotBundle, StagedSourceTextFile } from '../content-contracts.js';
import { SourceSnapshotError } from '../errors.js';
import type {
  ExportRepositorySnapshotOptions,
  RepositorySnapshotExportResult,
  RepositorySnapshotFreeze,
  RepositorySnapshotFreezeVerification,
  RepositorySnapshotPlan,
  RepositorySnapshotPlanOptions,
  SourceInventory,
} from './contracts.js';
import { collectSourceInventory } from './inventory.js';
import { publishSourceSnapshot } from './publish.js';

const encoder = new TextEncoder();
const errorCode = (error: unknown): string => error instanceof SourceSnapshotError ? error.code : 'SOURCE_READ_FAILED';

const inventoryIdentity = (inventory: SourceInventory): unknown => ({
  version: inventory.version,
  repositories: inventory.repositories.map(value => ({
    path: value.path, initialized: value.initialized, head: value.head, branch: value.branch,
    parentGitlink: value.parentGitlink, dirty: value.dirty, statusCount: value.statusCount,
  })),
  entries: inventory.entries.map(value => ({
    repositoryPath: value.repositoryPath, relativePath: value.relativePath, projectPath: value.projectPath,
    tracked: value.tracked, untracked: value.untracked, mode: value.mode, status: value.status,
    exists: value.exists, size: value.size, type: value.type,
  })),
  issues: inventory.issues.map(value => ({ ...value })),
});

const inventoryFingerprint = async (inventory: SourceInventory): Promise<string> => {
  const integrity = await calculateBytesIntegrity(encoder.encode(stringifyDeterministicJson(inventoryIdentity(inventory))));
  return integrity.sha256;
};

const repositoryManifestInput = (inventory: SourceInventory) => inventory.repositories
  .filter(value => value.initialized && value.head !== null && value.dirty !== null)
  .map(value => ({ path: value.path, head: value.head as string, branch: value.branch, dirty: value.dirty as boolean }));
export const planRepositorySnapshot = async (options: RepositorySnapshotPlanOptions): Promise<RepositorySnapshotPlan> => {
  const policy = defineSourceSnapshotPolicy(options.policy);
  const inventory = await collectSourceInventory({
    sourceRoot: options.sourceRoot,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const decisions = inventory.entries.map(entry => Object.freeze({
    path: entry.projectPath,
    decision: classifySourcePath({ path: entry.projectPath, exists: entry.exists, type: entry.type }, policy),
  }));
  const staged: StagedSourceTextFile[] = [];
  const contentIssues: Array<{ readonly path: string; readonly code: string }> = [];
  for (const entry of inventory.entries) {
    const selected = decisions.find(value => value.path === entry.projectPath);
    if (selected?.decision.action !== 'include') continue;
    try {
      const bytes = await readFile(entry.absolutePath);
      staged.push(await stageSourceTextFile({ path: entry.projectPath, group: options.groupForPath(entry.projectPath, entry), bytes }));
    } catch (error) {
      contentIssues.push(Object.freeze({ path: entry.projectPath, code: errorCode(error) }));
    }
  }
  const secretFindings = scanSourceSecrets(staged.map(value => ({ path: value.path, text: value.text })), options.additionalSecretRules ?? []);
  const reviewEntries = decisions.filter(value => value.decision.action === 'review');
  const publishAllowed = inventory.issues.length === 0 && reviewEntries.length === 0 && secretFindings.length === 0 && contentIssues.length === 0;
  let bundle: SourceSnapshotBundle | null = null;
  if (publishAllowed) {
    try {
      const textPackage = await buildSourceTextPackage(staged, options.pack);
      const manifest = await createTextSnapshotManifest({
        projectId: options.projectId, policyVersion: options.policyVersion, publishedAt: options.publishedAt,
        repositories: repositoryManifestInput(inventory), textPackage,
      });
      bundle = Object.freeze({ manifest, textPackage });
    } catch (error) {
      contentIssues.push(Object.freeze({ path: '', code: errorCode(error) }));
    }
  }
  const ready = publishAllowed && contentIssues.length === 0 && bundle !== null;
  const freeze: RepositorySnapshotFreeze = Object.freeze({
    inventoryFingerprint: await inventoryFingerprint(inventory),
    files: Object.freeze(staged.map(value => Object.freeze({ path: value.path, sha256: value.sha256 }))),
  });
  return Object.freeze({
    status: ready ? 'READY' : 'BLOCKED', publishAllowed: ready, inventory,
    decisions: Object.freeze(decisions), includedPaths: Object.freeze(staged.map(value => value.path)),
    reviewEntries: Object.freeze(reviewEntries), secretFindings, contentIssues: Object.freeze(contentIssues),
    bundle, freeze,
  });
};
export const verifyRepositorySnapshotFreeze = async (
  options: RepositorySnapshotPlanOptions,
  freeze: RepositorySnapshotFreeze,
): Promise<RepositorySnapshotFreezeVerification> => {
  const inventory = await collectSourceInventory({
    sourceRoot: options.sourceRoot,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const inventoryChanged = await inventoryFingerprint(inventory) !== freeze.inventoryFingerprint;
  const byPath = new Map(inventory.entries.map(value => [value.projectPath, value]));
  const changed: string[] = [];
  for (const frozen of freeze.files) {
    const current = byPath.get(frozen.path);
    if (current === undefined || !current.exists || current.type !== 'file') { changed.push(frozen.path); continue; }
    try {
      const integrity = await calculateBytesIntegrity(await readFile(current.absolutePath));
      if (integrity.sha256 !== frozen.sha256) changed.push(frozen.path);
    } catch { changed.push(frozen.path); }
  }
  const changedPaths = Object.freeze([...new Set(changed)].sort());
  return Object.freeze({ ok: !inventoryChanged && changedPaths.length === 0, inventoryChanged, changedPaths });
};

export const exportRepositorySnapshot = async (options: ExportRepositorySnapshotOptions): Promise<RepositorySnapshotExportResult> => {
  const plan = await planRepositorySnapshot(options);
  if (!plan.publishAllowed || plan.bundle === null) return Object.freeze({ status: 'BLOCKED', plan });
  const freeze = await verifyRepositorySnapshotFreeze(options, plan.freeze);
  if (!freeze.ok) throw new SourceSnapshotError('SOURCE_CHANGED', { inventoryChanged: freeze.inventoryChanged, changedPaths: freeze.changedPaths });
  const publication = await publishSourceSnapshot(plan.bundle, options);
  return Object.freeze({ status: publication.status, plan, publication });
};
