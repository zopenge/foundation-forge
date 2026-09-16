import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolvePathWithinRoot } from '@openge/forge-path-safety/node';
import type { SnapshotManifest } from '../contracts.js';
import type { SnapshotReadLimits, SnapshotTextReadResult } from '../content-contracts.js';
import { SourceSnapshotError } from '../errors.js';
import { collectSnapshotObjectRequirements, readSnapshotText } from '../text-reader.js';
import type {
  ReadPublishedSourceSnapshotTextOptions,
  SourceSnapshotUnpackResult,
  UnpackPublishedSourceSnapshotOptions,
  SourceSnapshotStorageLayoutOptions,
} from './contracts.js';
import { readManagedBytes } from './managed-read.js';
import {
  assertSourceTargetSeparation,
  loadStoredSourceSnapshotManifest,
  readCurrentSourceSnapshotId,
  readSourceSnapshotOwner,
} from './publish.js';
import { resolveStorageLayout } from './layout.js';

export const DEFAULT_SNAPSHOT_READ_LIMITS: SnapshotReadLimits = Object.freeze({
  maxObjectBytes: 1_048_576,
  maxFileBytes: 16_777_216,
  maxTotalBytes: 67_108_864,
});

const effectiveLimits = (value?: SnapshotReadLimits): SnapshotReadLimits => value ?? DEFAULT_SNAPSHOT_READ_LIMITS;
const loadAuthorizedManifest = async (
  options: SourceSnapshotStorageLayoutOptions & { readonly targetRoot: string; readonly ownerId: string; readonly snapshotId?: string },
): Promise<SnapshotManifest> => {
  const layout = resolveStorageLayout(options);
  const owner = await readSourceSnapshotOwner(options.targetRoot, options.ownerId, layout);
  const snapshotId = options.snapshotId ?? await readCurrentSourceSnapshotId(options.targetRoot, layout, true) as string;
  const manifest = await loadStoredSourceSnapshotManifest(options.targetRoot, snapshotId);
  if (owner.projectId !== manifest.projectId) {
    throw new SourceSnapshotError('TARGET_PROJECT_MISMATCH', { snapshotId });
  }
  return manifest;
};

export const readPublishedSourceSnapshotText = async (
  options: ReadPublishedSourceSnapshotTextOptions,
): Promise<SnapshotTextReadResult> => {
  const manifest = await loadAuthorizedManifest(options);
  const requirements = collectSnapshotObjectRequirements(manifest, [options.path]);
  const objects = await Promise.all(requirements.map(async object => {
    const bytes = await readManagedBytes(options.targetRoot, object.path, false);
    if (bytes === undefined) throw new SourceSnapshotError('OBJECT_MISSING', { path: object.path });
    return { path: object.path, bytes };
  }));
  return readSnapshotText(manifest, objects, options.path, effectiveLimits(options.limits));
};

const ensureEmptyOutputRoot = async (outputRoot: string): Promise<void> => {
  try {
    const metadata = await lstat(outputRoot);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new SourceSnapshotError('OUTPUT_NOT_EMPTY');
    if ((await readdir(outputRoot)).length > 0) throw new SourceSnapshotError('OUTPUT_NOT_EMPTY');
  } catch (error) {
    if (error instanceof SourceSnapshotError) throw error;
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      await mkdir(outputRoot, { recursive: true });
      return;
    }
    throw error;
  }
};
export const unpackPublishedSourceSnapshot = async (
  options: UnpackPublishedSourceSnapshotOptions,
): Promise<SourceSnapshotUnpackResult> => {
  await assertSourceTargetSeparation(options.targetRoot, options.outputRoot);
  await ensureEmptyOutputRoot(options.outputRoot);
  const manifest = await loadAuthorizedManifest(options);
  const written: string[] = [];
  for (const file of manifest.files) {
    const result = await readPublishedSourceSnapshotText({
      ...options,
      snapshotId: manifest.snapshotId,
      path: file.path,
      limits: effectiveLimits(options.limits),
    });
    const target = resolvePathWithinRoot(options.outputRoot, file.path);
    await mkdir(dirname(target), { recursive: true });
    try {
      await writeFile(target, result.text, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        throw new SourceSnapshotError('OUTPUT_NOT_EMPTY', { path: file.path, writtenFiles: [...written] });
      }
      throw error;
    }
    written.push(file.path);
  }
  return Object.freeze({
    status: 'UNPACKED' as const,
    snapshotId: manifest.snapshotId,
    writtenFileCount: written.length,
    writtenFiles: Object.freeze(written),
    assurance: 'normalized-text-verified' as const,
  });
};
