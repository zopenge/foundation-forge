import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolvePathWithinRoot } from '@openge/forge-path-safety/node';
import type { SnapshotManifest } from '../contracts.js';
import type { SnapshotObjectBytes, SnapshotReadLimits, SnapshotTextReadResult } from '../content-contracts.js';
import { parseSourceTextDetails } from '../text-format.js';
import { createSnapshotReadContext, requireSnapshotReadFile, collectReadContextRequirements } from '../read-context.js';
import { assertSnapshotObjectBudget, failSnapshotReadLimit, validateSnapshotReadLimits } from '../read-budget.js';
import { SourceSnapshotError } from '../errors.js';
import { readSnapshotText } from '../text-reader.js';
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
  const limits = effectiveLimits(options.limits);
  validateSnapshotReadLimits(limits);
  const manifest = await loadAuthorizedManifest(options);
  const context = createSnapshotReadContext(manifest);
  const details = parseSourceTextDetails(requireSnapshotReadFile(context, options.path).details);
  if (details.formatVersion !== 2) throw new SourceSnapshotError('TEXT_FORMAT_UNSUPPORTED', { path: options.path, availableAssurance: 'object-integrity' });
  if (details.normalizedByteLength > limits.maxFileBytes) failSnapshotReadLimit('maxFileBytes');
  const requirements = collectReadContextRequirements(context, [options.path]);
  assertSnapshotObjectBudget(requirements, limits);
  const objects: SnapshotObjectBytes[] = [];
  let remaining = limits.maxTotalBytes;
  for (const object of requirements) {
    const bytes = await readManagedBytes(options.targetRoot, object.path, false, {
      maxBytes: Math.min(limits.maxObjectBytes, remaining),
      field: remaining < limits.maxObjectBytes ? 'maxTotalBytes' : 'maxObjectBytes',
    });
    if (bytes === undefined) throw new SourceSnapshotError('OBJECT_MISSING', { path: object.path });
    if (bytes.byteLength !== object.byteLength) throw new SourceSnapshotError('OBJECT_INTEGRITY_MISMATCH', { path: object.path });
    remaining -= bytes.byteLength;
    objects.push({ path: object.path, bytes });
  }
  return readSnapshotText(manifest, objects, options.path, limits);
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
