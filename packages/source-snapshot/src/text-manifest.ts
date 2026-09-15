import { calculateBytesIntegrity } from '@openge/forge-artifact-integrity';
import type { SnapshotManifest, SnapshotFile } from './contracts.js';
import type { CreateTextSnapshotManifestInput, PackedSourceTextFile } from './content-contracts.js';
import { SourceSnapshotError } from './errors.js';
import { createSnapshotManifest } from './manifest.js';
import { reconstructSourceText } from './packing.js';
import { compareStrings } from './validation.js';

const encoder = new TextEncoder();
const verifyObjectIntegrity = async (value: CreateTextSnapshotManifestInput['textPackage']['objects'][number]): Promise<void> => {
  const integrity = await calculateBytesIntegrity(encoder.encode(value.content));
  if (integrity.sha256 !== value.sha256 || integrity.byteLength !== value.byteLength) {
    throw new SourceSnapshotError('OBJECT_INTEGRITY_MISMATCH', { path: value.path });
  }
};
const fileDetails = (file: PackedSourceTextFile): NonNullable<SnapshotFile['details']> => ({
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
export const createTextSnapshotManifest = async (input: CreateTextSnapshotManifestInput): Promise<SnapshotManifest> => {
  await Promise.all(input.textPackage.objects.map(verifyObjectIntegrity));
  for (const file of input.textPackage.files) reconstructSourceText(input.textPackage, file.path);
  return createSnapshotManifest({
    projectId: input.projectId,
    policyVersion: input.policyVersion,
    publishedAt: input.publishedAt,
    repositories: input.repositories,
    objects: input.textPackage.objects.map(object => ({ path: object.path, sha256: object.sha256, byteLength: object.byteLength })),
    files: input.textPackage.files.map(file => ({
      path: file.path,
      sha256: file.sha256,
      byteLength: file.byteLength,
      objectPaths: [...new Set(file.segments.map(segment => segment.objectPath))].sort(compareStrings),
      details: fileDetails(file),
    })),
  });
};
