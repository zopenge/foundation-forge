import { calculateBytesIntegrity } from '@openge/forge-artifact-integrity';
import type { SnapshotManifest, SnapshotFile } from './contracts.js';
import type { CreateTextSnapshotManifestInput, PackedSourceTextFile } from './content-contracts.js';
import { SourceSnapshotError } from './errors.js';
import { createSnapshotManifest } from './manifest.js';
import { reconstructPackedSourceText } from './packing.js';
import { calculateNormalizedTextIntegrity, SOURCE_TEXT_NORMALIZATION } from './text-integrity.js';
import { compareStrings } from './validation.js';

const encoder = new TextEncoder();
const VERIFY_CONCURRENCY = 32;
const verifyConcurrently = async <T>(values: readonly T[], operation: (value: T) => Promise<void>): Promise<void> => {
  let nextIndex = 0;
  const workerCount = Math.min(VERIFY_CONCURRENCY, values.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex; nextIndex += 1;
      await operation(values[index] as T);
    }
  }));
};
const verifyObjectIntegrity = async (value: CreateTextSnapshotManifestInput['textPackage']['objects'][number]): Promise<void> => {
  const integrity = await calculateBytesIntegrity(encoder.encode(value.content));
  if (integrity.sha256 !== value.sha256 || integrity.byteLength !== value.byteLength) {
    throw new SourceSnapshotError('OBJECT_INTEGRITY_MISMATCH', { path: value.path });
  }
};

const legacyFileDetails = (file: PackedSourceTextFile): NonNullable<SnapshotFile['details']> => ({
  group: file.group,
  encoding: file.encoding,
  bom: file.bom,
  lineCount: file.lineCount,
  segments: file.segments.map(segment => ({
    objectPath: segment.objectPath,
    objectSha256: segment.objectSha256,
    startLine: segment.startLine,
    endLine: segment.endLine,
    segmentIndex: segment.segmentIndex,
    segmentCount: segment.segmentCount,
  })),
});

const v2FileDetails = (file: PackedSourceTextFile): NonNullable<SnapshotFile['details']> => ({
  kind: 'source-text',
  formatVersion: 2,
  normalization: SOURCE_TEXT_NORMALIZATION,
  group: file.group,
  encoding: file.encoding,
  bom: file.bom,
  lineCount: file.lineCount,
  normalizedSha256: file.normalizedSha256,
  normalizedByteLength: file.normalizedByteLength,
  finalNewline: file.finalNewline,
  rawReconstruction: 'not-provided',
  segments: file.segments.map(segment => {
    if (segment.bodyByteOffset === undefined || segment.bodyByteLength === undefined || segment.sourceByteOffset === undefined) {
      throw new SourceSnapshotError('TEXT_DETAILS_INVALID', { path: file.path, field: 'segments.locator' });
    }
    return {
      objectPath: segment.objectPath,
      objectSha256: segment.objectSha256,
      bodyByteOffset: segment.bodyByteOffset,
      bodyByteLength: segment.bodyByteLength,
      sourceByteOffset: segment.sourceByteOffset,
      segmentIndex: segment.segmentIndex,
      segmentCount: segment.segmentCount,
      startLine: segment.startLine,
      endLine: segment.endLine,
    };
  }),
});

const verifyFileIntegrity = async (
  file: PackedSourceTextFile,
  objects: ReadonlyMap<string, CreateTextSnapshotManifestInput['textPackage']['objects'][number]>,
): Promise<void> => {
  const text = reconstructPackedSourceText(file, objects);
  if (file.textFormatVersion !== 2) return;
  const integrity = await calculateNormalizedTextIntegrity(text);
  if (
    integrity.normalizedSha256 !== file.normalizedSha256 ||
    integrity.normalizedByteLength !== file.normalizedByteLength ||
    integrity.finalNewline !== file.finalNewline
  ) {
    throw new SourceSnapshotError('TEXT_DETAILS_INVALID', { path: file.path, field: 'normalizedIntegrity' });
  }
};

export const createTextSnapshotManifest = async (input: CreateTextSnapshotManifestInput): Promise<SnapshotManifest> => {
  const objectsByPath = new Map(input.textPackage.objects.map(object => [object.path, object]));
  await verifyConcurrently(input.textPackage.objects, verifyObjectIntegrity);
  await verifyConcurrently(input.textPackage.files, file => verifyFileIntegrity(file, objectsByPath));
  return createSnapshotManifest({
    projectId: input.projectId,
    policyVersion: input.policyVersion,
    publishedAt: input.publishedAt,
    repositories: input.repositories,
    objects: input.textPackage.objects.map(object => ({
      path: object.path, sha256: object.sha256, byteLength: object.byteLength,
    })),
    files: input.textPackage.files.map(file => ({
      path: file.path,
      sha256: file.sha256,
      byteLength: file.byteLength,
      objectPaths: [...new Set(file.segments.map(segment => segment.objectPath))].sort(compareStrings),
      details: file.textFormatVersion === 2 ? v2FileDetails(file) : legacyFileDetails(file),
    })),
  });
};
