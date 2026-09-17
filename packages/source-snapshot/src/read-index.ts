import type { SnapshotManifest, SnapshotObject } from './contracts.js';
import { validatePortableRelativePath } from '@openge/forge-path-safety';
import type { SnapshotReadProfile, SourceTextDetails, SourceTextLocatorV2 } from './content-contracts.js';
import { SourceSnapshotError } from './errors.js';
import { collectReadContextRequirements, createSnapshotReadContext, readContextSourceDetails, requireSnapshotReadFile } from './read-context.js';
import type { SnapshotReadContext } from './read-context.js';
import { compareStrings } from './validation.js';
import { readIndexLines } from './read-index-render.js';

export type SnapshotReadAssurance = 'normalized-text-verified' | 'object-integrity';
export interface SnapshotReadIndexFile {
  readonly path: string;
  readonly sourceSha256: string;
  readonly sourceByteLength: number;
  readonly sourceLineCount: number;
  readonly group: string;
  readonly formatVersion: 1 | 2;
  /** 历史格式能力声明；只有 Reader 返回值才证明本次正文验证已经执行。 */
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

const indexFile = (context: SnapshotReadContext, path: string, validated?: SourceTextDetails): SnapshotReadIndexFile => {
  const file = requireSnapshotReadFile(context, path);
  const details = validated ?? readContextSourceDetails(context, file);
  const requirements = freezeRequirements(collectReadContextRequirements(context, [path]));
  if (details.formatVersion === 1) {
    return Object.freeze({
      path, sourceSha256: file.sha256, sourceByteLength: file.byteLength, sourceLineCount: details.lineCount,
      group: details.group, formatVersion: 1 as const, assurance: 'object-integrity' as const,
      objectRequirements: requirements, locators: Object.freeze([]),
    });
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
  const context = createSnapshotReadContext(manifest);
  const files = Object.freeze(
    [...manifest.files]
      .sort((a, b) => compareStrings(a.path, b.path))
      .map(file => indexFile(context, file.path)),
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
  let renderingLines = 0;
  for (const line of readIndexLines(draft)) {
    renderingLines += 1;
    for (const char of line) if (char === '\n') renderingLines += 1;
  }
  return Object.freeze({ ...draft, metrics: Object.freeze({ sourceLines, objectBytes, renderingLines }) });
};

const selectIndexFiles = (manifest: SnapshotManifest, paths: readonly string[]): ReadonlyMap<string, SnapshotReadIndexFile> => {
  const context = createSnapshotReadContext(manifest);
  const selected = new Set(paths);
  const byPath = new Map<string, SnapshotReadIndexFile>();
  for (const file of [...manifest.files].sort((a, b) => compareStrings(a.path, b.path))) {
    const details = readContextSourceDetails(context, file);
    if (selected.has(file.path)) byPath.set(file.path, indexFile(context, file.path, details));
  }
  return byPath;
};
const projectReadView = (
  manifest: SnapshotManifest,
  input: SnapshotReadViewInput,
  byPath: ReadonlyMap<string, SnapshotReadIndexFile>,
): SnapshotReadView => {
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
export const buildSnapshotReadView = (manifest: SnapshotManifest, input: SnapshotReadViewInput): SnapshotReadView => {
  requireViewId(input.viewId);
  if (input.snapshotId !== manifest.snapshotId) throw new SourceSnapshotError('SNAPSHOT_ID_MISMATCH', { snapshotId: input.snapshotId });
  return projectReadView(manifest, input, selectIndexFiles(manifest, input.paths));
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
  const byPath = selectIndexFiles(manifest, declared);
  return Object.freeze({
    profileId: profile.profileId, snapshotId: manifest.snapshotId, duplicatePaths,
    preferred: projectReadView(manifest, { viewId: `${profile.profileId}:preferred`, snapshotId: manifest.snapshotId, paths: profile.preferredPaths }, byPath),
    reference: projectReadView(manifest, { viewId: `${profile.profileId}:reference`, snapshotId: manifest.snapshotId, paths: profile.referencePaths }, byPath),
  });
};

export const renderSnapshotReadIndexMarkdown = (index: SnapshotReadIndex): string => `${[...readIndexLines(index)].join('\n')}\n`;
