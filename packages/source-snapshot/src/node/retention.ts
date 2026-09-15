import { execFile } from 'node:child_process';
import { lstat, readdir, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { defineGeneratedArtifactPlan } from '@openge/forge-generated-artifacts';
import { publishGeneratedArtifacts } from '@openge/forge-generated-artifacts/node';
import { resolveExistingPathWithinRoot, resolvePathWithinRoot } from '@openge/forge-path-safety/node';
import type { SnapshotManifest, SnapshotManifestInput } from '../contracts.js';
import { SourceSnapshotError } from '../errors.js';
import { createSnapshotManifest } from '../manifest.js';
import { planSnapshotRetention } from '../retention.js';
import type { InspectSourceSnapshotRetentionOptions, PruneSourceSnapshotsOptions, SourceSnapshotPruneResult, SourceSnapshotRetentionStatus } from './contracts.js';
import { resolveStorageLayout, type ResolvedSourceSnapshotLayout } from './layout.js';
import { acquireSourceSnapshotLock } from './lock.js';
import { readManagedText } from './managed-read.js';
import { verifyPublishedSourceSnapshot } from './publish.js';

const runFile = promisify(execFile);
const snapshotPattern = /^snapshot-[a-f0-9]{64}$/u;
const systemCode = (error: unknown): string | undefined => error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
const pathExists = async (path: string): Promise<boolean> => { try { await lstat(path); return true; } catch (error) { if (systemCode(error) === 'ENOENT') return false; throw error; } };
const loadManifest = async (targetRoot: string, snapshotId: string): Promise<SnapshotManifest> => {
  const text = await readManagedText(targetRoot, `snapshots/${snapshotId}/SNAPSHOT.json`, false);
  if (text === undefined) throw new SourceSnapshotError('SNAPSHOT_MISSING', { snapshotId });
  let value: Partial<SnapshotManifest>;
  try { value = JSON.parse(text) as Partial<SnapshotManifest>; }
  catch { throw new SourceSnapshotError('SNAPSHOT_STORE_INVALID', { snapshotId }); }
  try {
    const recreated = await createSnapshotManifest({
      projectId: value.projectId as string, policyVersion: value.policyVersion as string,
      publishedAt: value.publishedAt as number, repositories: value.repositories as SnapshotManifestInput['repositories'],
      files: value.files as SnapshotManifestInput['files'], objects: value.objects as SnapshotManifestInput['objects'],
    });
    if (value.snapshotId !== snapshotId || recreated.snapshotId !== snapshotId) throw new SourceSnapshotError('SNAPSHOT_STORE_INVALID', { snapshotId });
    return recreated;
  } catch (error) {
    if (error instanceof SourceSnapshotError && error.code === 'SNAPSHOT_STORE_INVALID') throw error;
    throw new SourceSnapshotError('SNAPSHOT_STORE_INVALID', { snapshotId });
  }
};

const listSnapshotManifests = async (targetRoot: string): Promise<readonly SnapshotManifest[]> => {
  const root = resolvePathWithinRoot(targetRoot, 'snapshots');
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (systemCode(error) === 'ENOENT') return []; throw error; }
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !snapshotPattern.test(entry.name)) {
      throw new SourceSnapshotError('SNAPSHOT_STORE_INVALID', { entry: entry.name });
    }
    ids.push(entry.name);
  }
  return Promise.all(ids.sort().map(id => loadManifest(targetRoot, id)));
};

const listObjectPaths = async (targetRoot: string): Promise<readonly string[]> => {
  const root = resolvePathWithinRoot(targetRoot, 'objects');
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (systemCode(error) === 'ENOENT') return []; throw error; }
  const result: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) throw new SourceSnapshotError('MANAGED_STORE_INVALID', { entry: entry.name });
    result.push(`objects/${entry.name}`);
  }
  return result.sort();
};

const readGcState = async (targetRoot: string, layout: ResolvedSourceSnapshotLayout): Promise<Readonly<Record<string, number>>> => {
  const text = await readManagedText(targetRoot, layout.gcFile, false);
  if (text === undefined) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new SourceSnapshotError('GC_STATE_INVALID'); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new SourceSnapshotError('GC_STATE_INVALID');
  const state = parsed as { schemaVersion?: unknown; orphanedSince?: unknown };
  if (state.schemaVersion !== 1 || typeof state.orphanedSince !== 'object' || state.orphanedSince === null || Array.isArray(state.orphanedSince)) {
    throw new SourceSnapshotError('GC_STATE_INVALID');
  }
  const result: Record<string, number> = {};
  for (const [path, value] of Object.entries(state.orphanedSince)) {
    if (!path.startsWith('objects/') || !Number.isSafeInteger(value) || (value as number) < 0) throw new SourceSnapshotError('GC_STATE_INVALID', { path });
    result[path] = value as number;
  }
  return Object.freeze(result);
};

const writeGcState = async (targetRoot: string, layout: ResolvedSourceSnapshotLayout, orphanedSince: Readonly<Record<string, number>>): Promise<void> => {
  const content = `${JSON.stringify({ schemaVersion: 1, orphanedSince }, null, 2)}\n`;
  const plan = defineGeneratedArtifactPlan({ artifacts: [{ path: layout.gcFile, content }], retiredPaths: [] });
  const result = await publishGeneratedArtifacts(targetRoot, plan, { pathCaseSensitivity: layout.pathCaseSensitivity });
  if (result.diagnostics.length > 0) throw new SourceSnapshotError('PUBLICATION_FAILED', { diagnostics: result.diagnostics });
  const actual = await readManagedText(targetRoot, layout.gcFile, false);
  if (actual !== content) throw new SourceSnapshotError('GC_STATE_INVALID', { reason: 'write-not-confirmed' });
};

interface RetentionPlanState {
  readonly layout: ResolvedSourceSnapshotLayout;
  readonly currentSnapshotId: string;
  readonly manifests: readonly SnapshotManifest[];
  readonly objectPaths: readonly string[];
  readonly plan: ReturnType<typeof planSnapshotRetention>;
  readonly observedOrphanCount: number;
}
const buildRetentionState = async (options: InspectSourceSnapshotRetentionOptions): Promise<RetentionPlanState> => {
  const layout = resolveStorageLayout(options);
  const current = await verifyPublishedSourceSnapshot({ ...options });
  const objectPaths = await listObjectPaths(options.targetRoot);
  const manifests = await listSnapshotManifests(options.targetRoot);
  const orphanedSince = await readGcState(options.targetRoot, layout);
  const plan = planSnapshotRetention({
    snapshots: manifests, currentSnapshotId: current.snapshotId, objectPaths, now: options.now,
    ...(options.keepCount === undefined ? {} : { keepCount: options.keepCount }),
    ...(options.orphanGraceMs === undefined ? {} : { orphanGraceMs: options.orphanGraceMs }), orphanedSince,
  });
  const observedOrphanCount = plan.orphanObjectPaths.filter(path => orphanedSince[path] !== undefined).length;
  return { layout, currentSnapshotId: current.snapshotId, manifests, objectPaths, plan, observedOrphanCount };
};

const statusFromState = (state: RetentionPlanState, grace: number): SourceSnapshotRetentionStatus => {
  const current = state.manifests.find(value => value.snapshotId === state.currentSnapshotId);
  if (current === undefined) throw new SourceSnapshotError('CURRENT_SNAPSHOT_MISSING');
  return Object.freeze({
    status: 'RETENTION_STATUS', currentSnapshotId: state.currentSnapshotId,
    snapshotCount: state.manifests.length, retentionSnapshotCount: state.plan.retainedSnapshotIds.length,
    retainedSnapshotIds: state.plan.retainedSnapshotIds, pruneCandidateSnapshotIds: state.plan.removeSnapshotIds,
    objectCount: state.objectPaths.length, currentObjectCount: current.objects.length,
    referencedObjectCount: state.plan.referencedObjectPaths.length, orphanObjectCount: state.plan.orphanObjectPaths.length,
    observedOrphanObjectCount: state.observedOrphanCount,
    unobservedOrphanObjectCount: state.plan.orphanObjectPaths.length - state.observedOrphanCount,
    eligibleObjectCount: state.plan.removeObjectPaths.length, orphanGraceMs: grace,
  });
};

export const inspectSourceSnapshotRetention = async (options: InspectSourceSnapshotRetentionOptions): Promise<SourceSnapshotRetentionStatus> => {
  const state = await buildRetentionState(options);
  return statusFromState(state, options.orphanGraceMs ?? 7 * 86_400_000);
};
interface ConfirmedDeleteOptions {
  readonly recursive: boolean;
  readonly primary?: (absolutePath: string, recursive: boolean) => Promise<void>;
  readonly fallback?: (absolutePath: string, recursive: boolean) => Promise<void>;
}
const defaultPrimary = async (absolutePath: string, recursive: boolean): Promise<void> => {
  await rm(absolutePath, { recursive, force: true, maxRetries: 3, retryDelay: 100 });
};
const defaultFallback = async (absolutePath: string, recursive: boolean): Promise<void> => {
  if (process.platform !== 'win32') return;
  const script = recursive
    ? "& { param([string]$p) Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction Stop }"
    : "& { param([string]$p) Remove-Item -LiteralPath $p -Force -ErrorAction Stop }";
  await runFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script, absolutePath], { windowsHide: true });
};

export const removeManagedPathConfirmed = async (targetRoot: string, logicalPath: string, options: ConfirmedDeleteOptions): Promise<boolean> => {
  const lexical = resolvePathWithinRoot(targetRoot, logicalPath);
  if (!await pathExists(lexical)) return false;
  const metadata = await lstat(lexical);
  if (metadata.isSymbolicLink()) throw new SourceSnapshotError('MANAGED_PATH_UNSAFE', { path: logicalPath });
  try { await resolveExistingPathWithinRoot(targetRoot, logicalPath); }
  catch { throw new SourceSnapshotError('MANAGED_PATH_UNSAFE', { path: logicalPath }); }
  const primary = options.primary ?? defaultPrimary;
  const fallback = options.fallback ?? defaultFallback;
  try { await primary(lexical, options.recursive); } catch { /* existence is authoritative */ }
  if (!await pathExists(lexical)) return true;
  try { await fallback(lexical, options.recursive); } catch { /* final existence check decides */ }
  if (await pathExists(lexical)) throw new SourceSnapshotError('DELETE_NOT_CONFIRMED', { path: logicalPath });
  return true;
};
const verifyRetained = async (options: InspectSourceSnapshotRetentionOptions, snapshotIds: readonly string[]): Promise<void> => {
  for (const snapshotId of snapshotIds) await verifyPublishedSourceSnapshot({ ...options, snapshotId });
};

export const pruneSourceSnapshots = async (options: PruneSourceSnapshotsOptions): Promise<SourceSnapshotPruneResult> => {
  const release = await acquireSourceSnapshotLock(options.lockPath);
  try {
    const state = await buildRetentionState(options);
    const grace = options.orphanGraceMs ?? 7 * 86_400_000;
    const initial = statusFromState(state, grace);
    await verifyRetained(options, state.plan.retainedSnapshotIds);
    if (options.dryRun === true) {
      return Object.freeze({ ...initial, status: 'PRUNE_PREVIEW',
        removeSnapshotIds: state.plan.removeSnapshotIds, removeObjectPaths: state.plan.removeObjectPaths,
        removedSnapshotIds: Object.freeze([]), removedObjectPaths: Object.freeze([]) });
    }

    const removedSnapshotIds: string[] = [];
    for (const snapshotId of state.plan.removeSnapshotIds) {
      await removeManagedPathConfirmed(options.targetRoot, `snapshots/${snapshotId}`, { recursive: true });
      removedSnapshotIds.push(snapshotId);
    }
    const removedObjectPaths: string[] = [];
    for (const path of state.plan.removeObjectPaths) {
      await removeManagedPathConfirmed(options.targetRoot, path, { recursive: false });
      removedObjectPaths.push(path);
    }

    const removedObjects = new Set(removedObjectPaths);
    const nextOrphanedSince = Object.fromEntries(Object.entries(state.plan.nextOrphanedSince).filter(([path]) => !removedObjects.has(path)));
    await writeGcState(options.targetRoot, state.layout, nextOrphanedSince);
    await verifyRetained(options, state.plan.retainedSnapshotIds);
    const final = await inspectSourceSnapshotRetention(options);
    return Object.freeze({ ...final, status: 'PRUNED',
      removeSnapshotIds: Object.freeze([...state.plan.removeSnapshotIds]), removeObjectPaths: Object.freeze([...state.plan.removeObjectPaths]),
      removedSnapshotIds: Object.freeze(removedSnapshotIds), removedObjectPaths: Object.freeze(removedObjectPaths) });
  } finally { await release(); }
};
