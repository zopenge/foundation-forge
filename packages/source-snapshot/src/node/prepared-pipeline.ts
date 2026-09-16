import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { classifySourcePath, defineSourceSnapshotPolicy, scanSourceSecrets } from '../index.js';
import { stageOwnedSourceTextFile } from '../packing.js';
import type { SnapshotManifest } from '../contracts.js';
import { createSnapshotManifest } from '../manifest.js';
import { parseSourceTextDetails } from '../text-format.js';
import { SourceSnapshotError } from '../errors.js';
import type {
  RepositorySnapshotDecision,
  RepositorySnapshotFreeze,
  RepositorySnapshotPlanOptions,
  SourceInventory,
} from './contracts.js';
import { collectSourceInventory } from './inventory.js';
import { calculateInventoryFingerprint, repositoryManifestInput } from './repository-state.js';
import { assertSourceTargetSeparation } from './publish.js';
import {
  createSourceTextSpoolBuilder,
  type PreparedSourceTextObject,
  type SourceTextSpoolBuilder,
} from './text-spool.js';

export interface PreparedRepositorySnapshotPlan {
  readonly status: 'READY' | 'BLOCKED';
  readonly publishAllowed: boolean;
  readonly inventory: SourceInventory;
  readonly decisions: readonly RepositorySnapshotDecision[];
  readonly includedPaths: readonly string[];
  readonly reviewEntries: readonly RepositorySnapshotDecision[];
  readonly secretFindings: readonly import('../content-contracts.js').SourceSecretFinding[];
  readonly contentIssues: readonly { readonly path: string; readonly code: string }[];
  readonly manifest: SnapshotManifest | null;
  readonly freeze: RepositorySnapshotFreeze;
}
export interface PreparedRepositorySnapshot {
  readonly plan: PreparedRepositorySnapshotPlan;
  readonly objects: readonly PreparedSourceTextObject[];
  readonly spoolRoot: string;
  dispose(): Promise<void>;
}
export interface PrepareRepositorySnapshotOptions extends RepositorySnapshotPlanOptions {
  readonly workRoot: string;
}

const errorCode = (error: unknown): string => error instanceof SourceSnapshotError ? error.code : 'SOURCE_READ_FAILED';
const sortFindings = <T extends { path: string; line: number; column: number; ruleId: string }>(values: readonly T[]): readonly T[] =>
  Object.freeze([...values].sort((a, b) => a.path.localeCompare(b.path, 'en') || a.line - b.line || a.column - b.column || a.ruleId.localeCompare(b.ruleId, 'en')));

export const prepareRepositorySnapshot = async (
  options: PrepareRepositorySnapshotOptions,
): Promise<PreparedRepositorySnapshot> => {
  await assertSourceTargetSeparation(options.sourceRoot, options.workRoot);
  await mkdir(options.workRoot, { recursive: true });
  const spoolRoot = await mkdtemp(join(options.workRoot, 'source-snapshot-prepared-'));
  let builder: SourceTextSpoolBuilder | null = null;
  try {
    const policy = defineSourceSnapshotPolicy(options.policy);
    const inventory = await collectSourceInventory({
      sourceRoot: options.sourceRoot,
      ...(options.submoduleHeadPolicy === undefined ? {} : { submoduleHeadPolicy: options.submoduleHeadPolicy }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const decisions = inventory.entries.map(entry => Object.freeze({
      path: entry.projectPath,
      decision: classifySourcePath({ path: entry.projectPath, exists: entry.exists, type: entry.type }, policy),
    }));
    const decisionByPath = new Map(decisions.map(value => [value.path, value.decision]));
    const reviewEntries = decisions.filter(value => value.decision.action === 'review');
    const includedPaths: string[] = [];
    const freezeFiles: Array<{ readonly path: string; readonly sha256: string }> = [];
    const secretFindings: import('../content-contracts.js').SourceSecretFinding[] = [];
    const contentIssues: Array<{ readonly path: string; readonly code: string }> = [];
    const staticBlocked = inventory.issues.length > 0 || reviewEntries.length > 0;
    if (!staticBlocked) builder = await createSourceTextSpoolBuilder({ spoolRoot, pack: options.pack });

    for (const entry of inventory.entries) {
      if (decisionByPath.get(entry.projectPath)?.action !== 'include') continue;
      try {
        const bytes = await readFile(entry.absolutePath);
        const staged = await stageOwnedSourceTextFile({
          path: entry.projectPath,
          group: options.groupForPath(entry.projectPath, entry),
          bytes,
        });
        includedPaths.push(staged.path);
        freezeFiles.push(Object.freeze({ path: staged.path, sha256: staged.sha256 }));
        const findings = scanSourceSecrets([{ path: staged.path, text: staged.text }], options.additionalSecretRules ?? []);
        secretFindings.push(...findings);
        if (findings.length > 0 && builder !== null) {
          await builder.dispose();
          builder = null;
        }
        if (builder !== null) await builder.add(staged);
      } catch (error) {
        contentIssues.push(Object.freeze({ path: entry.projectPath, code: errorCode(error) }));
        if (builder !== null) {
          await builder.dispose();
          builder = null;
        }
      }
    }

    let manifest: SnapshotManifest | null = null;
    let objects: readonly PreparedSourceTextObject[] = Object.freeze([]);
    const findings = sortFindings(secretFindings);
    const prePublishAllowed = inventory.issues.length === 0 && reviewEntries.length === 0 && findings.length === 0 && contentIssues.length === 0;
    if (prePublishAllowed && builder !== null) {
      try {
        const spooled = await builder.finish();
        for (const file of spooled.files) parseSourceTextDetails(file.details);
        manifest = await createSnapshotManifest({
          projectId: options.projectId,
          policyVersion: options.policyVersion,
          publishedAt: options.publishedAt,
          repositories: repositoryManifestInput(inventory),
          files: spooled.files,
          objects: spooled.objects.map(({ path, sha256, byteLength }) => ({ path, sha256, byteLength })),
        });
        objects = spooled.objects;
      } catch (error) {
        contentIssues.push(Object.freeze({ path: '', code: errorCode(error) }));
      }
    }
    const ready = prePublishAllowed && contentIssues.length === 0 && manifest !== null;
    const freeze: RepositorySnapshotFreeze = Object.freeze({
      inventoryFingerprint: await calculateInventoryFingerprint(inventory),
      files: Object.freeze(freezeFiles),
    });
    const plan: PreparedRepositorySnapshotPlan = Object.freeze({
      status: ready ? 'READY' : 'BLOCKED',
      publishAllowed: ready,
      inventory,
      decisions: Object.freeze(decisions),
      includedPaths: Object.freeze(includedPaths),
      reviewEntries: Object.freeze(reviewEntries),
      secretFindings: findings,
      contentIssues: Object.freeze(contentIssues),
      manifest: ready ? manifest : null,
      freeze,
    });
    const dispose = async (): Promise<void> => {
      if (builder !== null) await builder.dispose();
      else await rm(spoolRoot, { recursive: true, force: true });
    };
    return Object.freeze({ plan, objects: ready ? objects : Object.freeze([]), spoolRoot, dispose });
  } catch (error) {
    if (builder !== null) await builder.dispose();
    else await rm(spoolRoot, { recursive: true, force: true });
    throw error;
  }
};
