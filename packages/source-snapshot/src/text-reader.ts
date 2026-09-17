import { calculateBytesIntegrity } from '@openge/forge-artifact-integrity';
import type { SnapshotManifest, SnapshotObject } from './contracts.js';
import type {
  SnapshotObjectBytes,
  SnapshotReadLimits,
  SnapshotTextReadResult,
  SourceTextDetailsV2,
} from './content-contracts.js';
import { SourceSnapshotError } from './errors.js';
import { createSnapshotManifest } from './manifest.js';
import { parseSourceTextDetails } from './text-format.js';
import { calculateNormalizedTextIntegrity } from './text-integrity.js';
import { collectReadContextRequirements, createSnapshotReadContext, requireSnapshotReadFile } from './read-context.js';
import type { SnapshotReadContext } from './read-context.js';
import { copySnapshotReadObjects, failSnapshotReadLimit as failLimit, validateSnapshotReadLimits as validateLimits } from './read-budget.js';

const decoder = new TextDecoder('utf-8', { fatal: true });
const lineCount = (text: string): number => {
  if (text.length === 0) return 0;
  let count = 0;
  for (const char of text) if (char === '\n') count += 1;
  return text.endsWith('\n') ? count : count + 1;
};
const assertManifestIdentity = async (manifest: SnapshotManifest): Promise<void> => {
  const recreated = await createSnapshotManifest({
    projectId: manifest.projectId,
    policyVersion: manifest.policyVersion,
    publishedAt: manifest.publishedAt,
    repositories: manifest.repositories,
    files: manifest.files,
    objects: manifest.objects,
  });
  if (recreated.snapshotId !== manifest.snapshotId) {
    throw new SourceSnapshotError('SNAPSHOT_ID_MISMATCH', { snapshotId: manifest.snapshotId });
  }
};

export const collectSnapshotObjectRequirements = (
  manifest: SnapshotManifest,
  paths: readonly string[],
): readonly SnapshotObject[] => collectReadContextRequirements(createSnapshotReadContext(manifest), paths);

const parseV2 = (context: SnapshotReadContext, path: string): SourceTextDetailsV2 => {
  const details = parseSourceTextDetails(requireSnapshotReadFile(context, path).details);
  if (details.formatVersion !== 2) {
    throw new SourceSnapshotError('TEXT_FORMAT_UNSUPPORTED', {
      path,
      availableAssurance: 'object-integrity',
    });
  }
  return details;
};

const verifyRequiredObjects = async (
  requirements: readonly SnapshotObject[],
  provided: ReadonlyMap<string, Uint8Array>,
): Promise<ReadonlyMap<string, Uint8Array>> => {
  const verified = new Map<string, Uint8Array>();
  for (const requirement of requirements) {
    const bytes = provided.get(requirement.path);
    if (bytes === undefined) throw new SourceSnapshotError('OBJECT_MISSING', { path: requirement.path });
    const integrity = await calculateBytesIntegrity(bytes);
    if (integrity.sha256 !== requirement.sha256 || integrity.byteLength !== requirement.byteLength) {
      throw new SourceSnapshotError('OBJECT_INTEGRITY_MISMATCH', { path: requirement.path });
    }
    verified.set(requirement.path, bytes);
  }
  return verified;
};

const decodeBody = (bytes: Uint8Array, offset: number, length: number, path: string): string => {
  if (offset + length > bytes.byteLength) {
    throw new SourceSnapshotError('TEXT_DETAILS_INVALID', { path, field: 'bodyByteRange' });
  }
  try {
    return decoder.decode(bytes.subarray(offset, offset + length));
  } catch {
    throw new SourceSnapshotError('TEXT_INTEGRITY_MISMATCH', { path, reason: 'invalid-utf8-body' });
  }
};
export const readSnapshotText = async (
  manifest: SnapshotManifest,
  objects: readonly SnapshotObjectBytes[],
  path: string,
  limits: SnapshotReadLimits,
): Promise<SnapshotTextReadResult> => {
  validateLimits(limits);
  await assertManifestIdentity(manifest);
  const context = createSnapshotReadContext(manifest);
  const file = requireSnapshotReadFile(context, path);
  const details = parseV2(context, path);
  if (details.normalizedByteLength > limits.maxFileBytes) failLimit('maxFileBytes');
  const requirements = collectReadContextRequirements(context, [path]);
  const verified = await verifyRequiredObjects(requirements, copySnapshotReadObjects(requirements, objects, limits));
  const locators = [...details.segments].sort((a, b) => a.segmentIndex - b.segmentIndex);
  if (locators.length !== details.segments.length || locators.length !== (locators[0]?.segmentCount ?? 0)) {
    throw new SourceSnapshotError('TEXT_DETAILS_INVALID', { path, field: 'segments' });
  }

  const parts: string[] = [];
  let sourceOffset = 0;
  for (let index = 0; index < locators.length; index += 1) {
    const locator = locators[index];
    if (locator === undefined || locator.segmentIndex !== index + 1 || locator.segmentCount !== locators.length) {
      throw new SourceSnapshotError('TEXT_DETAILS_INVALID', { path, field: 'segmentIndex' });
    }
    if (locator.sourceByteOffset !== sourceOffset) {
      throw new SourceSnapshotError('TEXT_DETAILS_INVALID', { path, field: 'sourceByteOffset' });
    }
    const object = verified.get(locator.objectPath);
    if (object === undefined) throw new SourceSnapshotError('OBJECT_MISSING', { path: locator.objectPath });
    const declared = context.objectByPath.get(locator.objectPath);
    if (declared?.sha256 !== locator.objectSha256) {
      throw new SourceSnapshotError('TEXT_DETAILS_INVALID', { path, field: 'objectSha256' });
    }
    parts.push(decodeBody(object, locator.bodyByteOffset, locator.bodyByteLength, path));
    sourceOffset += locator.bodyByteLength;
  }
  const text = parts.join('');
  const integrity = await calculateNormalizedTextIntegrity(text);
  if (
    sourceOffset !== details.normalizedByteLength ||
    integrity.normalizedByteLength !== details.normalizedByteLength ||
    integrity.normalizedSha256 !== details.normalizedSha256 ||
    integrity.finalNewline !== details.finalNewline ||
    lineCount(text) !== details.lineCount
  ) {
    throw new SourceSnapshotError('TEXT_INTEGRITY_MISMATCH', { path });
  }

  return Object.freeze({
    snapshotId: manifest.snapshotId,
    path,
    text,
    normalizedSha256: details.normalizedSha256,
    sourceSha256: file.sha256,
    assurance: 'normalized-text-verified' as const,
  });
};
