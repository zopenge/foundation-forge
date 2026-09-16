import { lstat, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolvePathWithinRoot } from '@openge/forge-path-safety/node';
import { SourceSnapshotError } from '../errors.js';
import type { SourceSnapshotStoreBudget } from './contracts.js';
import type { ResolvedSourceSnapshotLayout } from './layout.js';

export type ManagedStoreCategory = 'object' | 'snapshot' | 'state';
export interface ManagedStoreFile {
  readonly path: string;
  readonly byteLength: number;
  readonly category: ManagedStoreCategory;
}
export interface ManagedStoreMeasurement {
  readonly files: readonly ManagedStoreFile[];
  readonly managedFileCount: number;
  readonly managedBytes: number;
  readonly objectFileCount: number;
  readonly objectBytes: number;
  readonly snapshotFileCount: number;
  readonly snapshotBytes: number;
  readonly stateFileCount: number;
  readonly stateBytes: number;
}
const snapshotPattern = /^snapshot-[a-f0-9]{64}$/u;
const code = (error: unknown): string | undefined => error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
const readFileStat = async (absolutePath: string, logicalPath: string): Promise<number | null> => {
  try {
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new SourceSnapshotError('MANAGED_STORE_INVALID', { path: logicalPath });
    return metadata.size;
  } catch (error) {
    if (code(error) === 'ENOENT') return null;
    throw error;
  }
};
const ensureDirectory = async (absolutePath: string, logicalPath: string): Promise<boolean> => {
  try {
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new SourceSnapshotError('MANAGED_STORE_INVALID', { path: logicalPath });
    return true;
  } catch (error) {
    if (code(error) === 'ENOENT') return false;
    throw error;
  }
};
const summarize = (files: readonly ManagedStoreFile[]): ManagedStoreMeasurement => {
  const values = (category: ManagedStoreCategory) => files.filter(file => file.category === category);
  const bytes = (items: readonly ManagedStoreFile[]) => items.reduce((sum, file) => sum + file.byteLength, 0);
  const objects = values('object'); const snapshots = values('snapshot'); const state = values('state');
  return Object.freeze({
    files: Object.freeze([...files].sort((a, b) => a.path.localeCompare(b.path))),
    managedFileCount: files.length, managedBytes: bytes(files),
    objectFileCount: objects.length, objectBytes: bytes(objects),
    snapshotFileCount: snapshots.length, snapshotBytes: bytes(snapshots),
    stateFileCount: state.length, stateBytes: bytes(state),
  });
};
export const measureManagedSourceSnapshotStore = async (
  targetRoot: string,
  layout: ResolvedSourceSnapshotLayout,
): Promise<ManagedStoreMeasurement> => {
  const root = resolve(targetRoot);
  if (!await ensureDirectory(root, '.')) throw new SourceSnapshotError('TARGET_NOT_OWNED');
  const files: ManagedStoreFile[] = [];
  for (const path of [layout.entryFile, layout.ownerFile, layout.gcFile, layout.pinsFile]) {
    const size = await readFileStat(resolvePathWithinRoot(root, path), path);
    if (size !== null) files.push({ path, byteLength: size, category: 'state' });
  }
  const objectsRoot = resolvePathWithinRoot(root, 'objects');
  if (await ensureDirectory(objectsRoot, 'objects')) {
    for (const entry of await readdir(objectsRoot, { withFileTypes: true })) {
      const path = `objects/${entry.name}`;
      if (!entry.isFile() || entry.isSymbolicLink()) throw new SourceSnapshotError('MANAGED_STORE_INVALID', { path });
      const size = await readFileStat(resolvePathWithinRoot(root, path), path);
      if (size === null) throw new SourceSnapshotError('MANAGED_STORE_INVALID', { path });
      files.push({ path, byteLength: size, category: 'object' });
    }
  }
  const snapshotsRoot = resolvePathWithinRoot(root, 'snapshots');
  if (await ensureDirectory(snapshotsRoot, 'snapshots')) {
    for (const snapshot of await readdir(snapshotsRoot, { withFileTypes: true })) {
      if (!snapshot.isDirectory() || snapshot.isSymbolicLink() || !snapshotPattern.test(snapshot.name)) throw new SourceSnapshotError('SNAPSHOT_STORE_INVALID', { entry: snapshot.name });
      const directory = `snapshots/${snapshot.name}`;
      for (const entry of await readdir(resolvePathWithinRoot(root, directory), { withFileTypes: true })) {
        const path = `${directory}/${entry.name}`;
        if (!entry.isFile() || entry.isSymbolicLink()) throw new SourceSnapshotError('SNAPSHOT_STORE_INVALID', { path });
        const size = await readFileStat(resolvePathWithinRoot(root, path), path);
        if (size === null) throw new SourceSnapshotError('SNAPSHOT_STORE_INVALID', { path });
        files.push({ path, byteLength: size, category: 'snapshot' });
      }
    }
  }
  return summarize(files);
};
const categoryFor = (path: string): ManagedStoreCategory => path.startsWith('objects/') ? 'object' : path.startsWith('snapshots/') ? 'snapshot' : 'state';
export const assertProjectedSourceSnapshotStoreBudget = (
  current: ManagedStoreMeasurement,
  plannedArtifacts: readonly { readonly path: string; readonly content: string }[],
  budget: SourceSnapshotStoreBudget,
): Readonly<{ managedFileCount: number; managedBytes: number; newPhysicalBytes: number }> => {
  for (const [field, value] of Object.entries(budget)) if (!Number.isSafeInteger(value) || value < 0) throw new SourceSnapshotError('INVALID_INPUT', { field: `storeBudget.${field}` });
  const encoder = new TextEncoder(); const map = new Map(current.files.map(file => [file.path, file])); let newPhysicalBytes = 0;
  for (const artifact of plannedArtifacts) {
    const byteLength = encoder.encode(artifact.content).byteLength; const previous = map.get(artifact.path);
    if (previous === undefined) newPhysicalBytes += byteLength; else if (byteLength > previous.byteLength) newPhysicalBytes += byteLength - previous.byteLength;
    map.set(artifact.path, { path: artifact.path, byteLength, category: categoryFor(artifact.path) });
  }
  const managedBytes = [...map.values()].reduce((sum, file) => sum + file.byteLength, 0); const managedFileCount = map.size;
  if (managedFileCount > budget.maxManagedFiles || managedBytes > budget.maxManagedBytes) {
    throw new SourceSnapshotError('STORE_BUDGET_EXCEEDED', {
      currentManagedFileCount: current.managedFileCount,
      currentManagedBytes: current.managedBytes,
      projectedManagedFileCount: managedFileCount,
      projectedManagedBytes: managedBytes,
      newPhysicalBytes,
      ...budget,
    });
  }
  return Object.freeze({ managedFileCount, managedBytes, newPhysicalBytes });
};
