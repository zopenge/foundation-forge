import type { SnapshotManifest, SnapshotObject } from './contracts.js';
import { validatePortableRelativePath } from '@openge/forge-path-safety';
import type { SnapshotReadProfile, SourceTextLocatorV2 } from './content-contracts.js';
import { SourceSnapshotError } from './errors.js';
import { parseSourceTextDetails } from './text-format.js';
import { collectSnapshotObjectRequirements } from './text-reader.js';
import { compareStrings } from './validation.js';

export type SnapshotReadAssurance = 'normalized-text-verified' | 'object-integrity';
export interface SnapshotReadIndexFile {
  readonly path: string;
  readonly sourceSha256: string;
  readonly sourceByteLength: number;
  readonly sourceLineCount: number;
  readonly group: string;
  readonly formatVersion: 1 | 2;
  readonly assurance: SnapshotReadAssurance;
  readonly normalizedSha256?: string;
  readonly normalizedByteLength?: number;
  readonly objectRequirements: readonly SnapshotObject[];
  readonly locators: readonly SourceTextLocatorV2[];
}
export interface SnapshotReadIndexMetrics {
  readonly sourceLines: number;
  readonly objectBytes: number;
  readonly renderingLines: number;
}
export interface SnapshotReadIndex {
  readonly schemaVersion: 1;
  readonly snapshotId: string;
  readonly fileCount: number;
  readonly metrics: SnapshotReadIndexMetrics;
  readonly files: readonly SnapshotReadIndexFile[];
}
export interface SnapshotReadViewInput {
  readonly viewId: string;
  readonly snapshotId: string;
  readonly paths: readonly string[];
}
export interface SnapshotReadView {
  readonly viewId: string;
  readonly snapshotId: string;
  readonly found: readonly string[];
  readonly missing: readonly string[];
  readonly unsupported: readonly string[];
  readonly files: readonly SnapshotReadIndexFile[];
}
export interface SnapshotReadProfileView {
  readonly profileId: string;
  readonly snapshotId: string;
  readonly duplicatePaths: readonly string[];
  readonly preferred: SnapshotReadView;
  readonly reference: SnapshotReadView;
}

const requireViewId = (value: string): void => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SourceSnapshotError('INVALID_INPUT', { field: 'viewId' });
  }
};
const freezeRequirements = (value: readonly SnapshotObject[]): readonly SnapshotObject[] =>
  Object.freeze(value.map(object => Object.freeze({ ...object })));

const indexFile = (manifest: SnapshotManifest, path: string): SnapshotReadIndexFile => {
  const file = manifest.files.find(candidate => candidate.path === path);
  if (file === undefined) throw new SourceSnapshotError('FILE_NOT_PACKED', { path });
  const details = parseSourceTextDetails(file.details);
  const requirements = freezeRequirements(collectSnapshotObjectRequirements(manifest, [path]));
  if (details.formatVersion === 1) {
    return Object.freeze({
      path, sourceSha256: file.sha256, sourceByteLength: file.byteLength, sourceLineCount: details.lineCount,
      group: details.group, formatVersion: 1 as const, assurance: 'object-integrity' as const,
      objectRequirements: requirements, locators: Object.freeze([]),
    });
  }

  const requirementByPath = new Map(requirements.map(object => [object.path, object]));
  for (const locator of details.segments) {
    const object = requirementByPath.get(locator.objectPath);
    if (object === undefined || object.sha256 !== locator.objectSha256) {
      throw new SourceSnapshotError('TEXT_DETAILS_INVALID', { path, field: 'locator.object' });
    }
  }
  return Object.freeze({
    path,
    sourceSha256: file.sha256,
    sourceByteLength: file.byteLength,
    sourceLineCount: details.lineCount,
    group: details.group,
    formatVersion: 2 as const,
    assurance: 'normalized-text-verified' as const,
    normalizedSha256: details.normalizedSha256,
    normalizedByteLength: details.normalizedByteLength,
    objectRequirements: requirements,
    locators: Object.freeze(details.segments.map(locator => Object.freeze({ ...locator }))),
  });
};

export const buildSnapshotReadIndex = (manifest: SnapshotManifest): SnapshotReadIndex => {
  const files = Object.freeze(
    [...manifest.files]
      .sort((a, b) => compareStrings(a.path, b.path))
      .map(file => indexFile(manifest, file.path)),
  );
  const sourceLines = files.reduce((sum, file) => sum + file.sourceLineCount, 0);
  const uniqueObjects = new Map<string, SnapshotObject>();
  for (const file of files) for (const object of file.objectRequirements) uniqueObjects.set(object.path, object);
  const objectBytes = [...uniqueObjects.values()].reduce((sum, object) => sum + object.byteLength, 0);
  const draft: SnapshotReadIndex = {
    schemaVersion: 1,
    snapshotId: manifest.snapshotId,
    fileCount: files.length,
    metrics: { sourceLines, objectBytes, renderingLines: 0 },
    files,
  };
  const renderingLines = renderSnapshotReadIndexMarkdown(draft).split('\n').length - 1;
  return Object.freeze({ ...draft, metrics: Object.freeze({ sourceLines, objectBytes, renderingLines }) });
};

export const buildSnapshotReadView = (
  manifest: SnapshotManifest,
  input: SnapshotReadViewInput,
): SnapshotReadView => {
  requireViewId(input.viewId);
  if (input.snapshotId !== manifest.snapshotId) {
    throw new SourceSnapshotError('SNAPSHOT_ID_MISMATCH', { snapshotId: input.snapshotId });
  }
  const index = buildSnapshotReadIndex(manifest);
  const byPath = new Map(index.files.map(file => [file.path, file]));
  const found: string[] = [];
  const missing: string[] = [];
  const unsupported: string[] = [];
  const files: SnapshotReadIndexFile[] = [];
  for (const path of [...new Set(input.paths)].sort(compareStrings)) {
    const file = byPath.get(path);
    if (file === undefined) missing.push(path);
    else if (file.assurance !== 'normalized-text-verified') unsupported.push(path);
    else { found.push(path); files.push(file); }
  }
  return Object.freeze({
    viewId: input.viewId,
    snapshotId: manifest.snapshotId,
    found: Object.freeze(found),
    missing: Object.freeze(missing),
    unsupported: Object.freeze(unsupported),
    files: Object.freeze(files),
  });
};
export const buildSnapshotReadProfileView = (
  manifest: SnapshotManifest,
  profile: SnapshotReadProfile,
): SnapshotReadProfileView => {
  requireViewId(profile.profileId);
  if (profile.snapshotId !== manifest.snapshotId) throw new SourceSnapshotError('ANALYSIS_SOURCE_MISMATCH', { field: 'snapshotId', snapshotId: profile.snapshotId });
  const declared = [...profile.preferredPaths, ...profile.referencePaths];
  const counts = new Map<string, number>();
  for (const path of declared) {
    try { validatePortableRelativePath(path); } catch { throw new SourceSnapshotError('INVALID_INPUT', { field: 'profilePath', path }); }
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  const duplicatePaths = Object.freeze([...counts.entries()].filter(([, count]) => count > 1).map(([path]) => path).sort(compareStrings));
  return Object.freeze({
    profileId: profile.profileId, snapshotId: manifest.snapshotId, duplicatePaths,
    preferred: buildSnapshotReadView(manifest, { viewId: `${profile.profileId}:preferred`, snapshotId: manifest.snapshotId, paths: profile.preferredPaths }),
    reference: buildSnapshotReadView(manifest, { viewId: `${profile.profileId}:reference`, snapshotId: manifest.snapshotId, paths: profile.referencePaths }),
  });
};

export const renderSnapshotReadIndexMarkdown = (index: SnapshotReadIndex): string => {
  const lines = [
    '# Source Snapshot', '',
    `- Snapshot ID: \`${index.snapshotId}\``,
    `- Source files: ${index.fileCount}`, '',
    '## Files', '',
  ];
  for (const file of index.files) {
    lines.push(`### \`${file.path}\``);
    lines.push('');
    lines.push(`- Assurance: \`${file.assurance}\``);
    lines.push(`- Format: v${file.formatVersion}`);
    lines.push(`- Source SHA-256: \`${file.sourceSha256}\``);
    for (const object of file.objectRequirements) {
      lines.push(`- Object: \`${object.path}\` (${object.byteLength} bytes)`);
    }
    for (const locator of file.locators) {
      lines.push(
        `- Segment ${locator.segmentIndex}/${locator.segmentCount}: ` +
        `\`${locator.objectPath}\` body ${locator.bodyByteOffset}+${locator.bodyByteLength}; ` +
        `source lines ${locator.startLine}-${locator.endLine}`,
      );
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
};