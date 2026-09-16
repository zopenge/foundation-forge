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
import { compareStrings } from './validation.js';

const decoder = new TextDecoder('utf-8', { fatal: true });
const lineCount = (text: string): number => {
  if (text.length === 0) return 0;
  let count = 0;
  for (const char of text) if (char === '\n') count += 1;
  return text.endsWith('\n') ? count : count + 1;
};
const failLimit = (field: keyof SnapshotReadLimits): never => {
  throw new SourceSnapshotError('TEXT_READ_LIMIT_EXCEEDED', { field });
};
const validateLimits = (limits: SnapshotReadLimits): void => {
  for (const field of ['maxObjectBytes', 'maxFileBytes', 'maxTotalBytes'] as const) {
    const value = limits[field];
    if (!Number.isSafeInteger(value) || value <= 0) throw new SourceSnapshotError('INVALID_INPUT', { field });
  }
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

const fileForPath = (manifest: SnapshotManifest, path: string) => {
  const file = manifest.files.find(candidate => candidate.path === path);
  if (file === undefined) throw new SourceSnapshotError('FILE_NOT_PACKED', { path });
  return file;
};

const objectMap = (manifest: SnapshotManifest): ReadonlyMap<string, SnapshotObject> => {
  const map = new Map<string, SnapshotObject>();
  for (const object of manifest.objects) {
    if (map.has(object.path)) throw new SourceSnapshotError('OBJECT_CONFLICT', { path: object.path });
    map.set(object.path, object);
  }
  return map;
};

export const collectSnapshotObjectRequirements = (
  manifest: SnapshotManifest,
  paths: readonly string[],
): readonly SnapshotObject[] => {  const objects = objectMap(manifest);
  const required = new Map<string, SnapshotObject>();
  for (const path of paths) {
    const file = fileForPath(manifest, path);
    for (const objectPath of file.objectPaths) {
      const object = objects.get(objectPath);
      if (object === undefined) throw new SourceSnapshotError('DANGLING_OBJECT', { path: objectPath });
      required.set(object.path, object);
    }
  }
  return Object.freeze([...required.values()].sort((a, b) => compareStrings(a.path, b.path)));
};

const parseV2 = (manifest: SnapshotManifest, path: string): SourceTextDetailsV2 => {
  const details = parseSourceTextDetails(fileForPath(manifest, path).details);
  if (details.formatVersion !== 2) {
    throw new SourceSnapshotError('TEXT_FORMAT_UNSUPPORTED', {
      path,
      availableAssurance: 'object-integrity',
    });
  }
  return details;
};

const providedObjectMap = (objects: readonly SnapshotObjectBytes[]): ReadonlyMap<string, Uint8Array> => {
  const result = new Map<string, Uint8Array>();
  for (const object of objects) {
    if (result.has(object.path)) throw new SourceSnapshotError('OBJECT_CONFLICT', { path: object.path });
    result.set(object.path, Uint8Array.from(object.bytes));
  }
  return result;
};
const verifyRequiredObjects = async (
  requirements: readonly SnapshotObject[],
  provided: ReadonlyMap<string, Uint8Array>,
  limits: SnapshotReadLimits,
): Promise<ReadonlyMap<string, Uint8Array>> => {
  const requiredPaths = new Set(requirements.map(requirement => requirement.path));
  for (const path of provided.keys()) {
    if (!requiredPaths.has(path)) throw new SourceSnapshotError('OBJECT_CONFLICT', { path, reason: 'unexpected-object' });
  }
  let total = 0;
  const verified = new Map<string, Uint8Array>();
  for (const requirement of requirements) {
    if (requirement.byteLength > limits.maxObjectBytes) failLimit('maxObjectBytes');
    total += requirement.byteLength;
    if (total > limits.maxTotalBytes) failLimit('maxTotalBytes');
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
  const file = fileForPath(manifest, path);
  const details = parseV2(manifest, path);
  if (details.normalizedByteLength > limits.maxFileBytes) failLimit('maxFileBytes');
  const requirements = collectSnapshotObjectRequirements(manifest, [path]);
  const verified = await verifyRequiredObjects(requirements, providedObjectMap(objects), limits);
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
    const declared = manifest.objects.find(value => value.path === locator.objectPath);
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
