import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { calculateBytesIntegrity } from '@openge/forge-artifact-integrity';
import { validatePortableRelativePath } from '@openge/forge-path-safety';
import type { SnapshotFile, SnapshotObject } from '../contracts.js';
import type {
  SourceTextFormatVersion,
  SourceTextLocatorV2,
  SourceTextPackageMetrics,
  SourceTextPackOptions,
  StagedSourceTextFile,
} from '../content-contracts.js';
import { sourceTextContentKey } from '../content-dedup.js';
import { SourceSnapshotError } from '../errors.js';
import {
  sourceTextObjectInputForSegment,
  splitSourceTextFile,
  validateSourceTextPackOptions,
} from '../packing.js';
import { SOURCE_TEXT_NORMALIZATION } from '../text-integrity.js';
import {
  renderSourceTextObjectHeader,
  renderSourceTextObjectSection,
} from '../text-object-renderer.js';
import { compareStrings } from '../validation.js';
const encoder = new TextEncoder();

type StoredFile = Omit<StagedSourceTextFile, 'text'> & { readonly contentKey: string };
type StoredBlock = Omit<StagedSourceTextFile, 'text'> & {
  readonly contentKey: string;
  readonly bodySpoolPath: string;
};
interface PendingLocator {
  readonly contentKey: string;
  readonly bodyByteOffset: number;
  readonly bodyByteLength: number;
  readonly sourceByteOffset: number;
  readonly segmentIndex: number;
  readonly segmentCount: number;
  readonly startLine: number;
  readonly endLine: number;
}
type LocatorRecord = SourceTextLocatorV2;

export interface PreparedSourceTextObject extends SnapshotObject {
  readonly spoolPath: string;
}
export interface SourceTextSpoolResult {
  readonly files: readonly SnapshotFile[];
  readonly objects: readonly PreparedSourceTextObject[];
  readonly metrics: SourceTextPackageMetrics;
}
export interface SourceTextSpoolBuilder {
  add(file: StagedSourceTextFile): Promise<void>;
  finish(): Promise<SourceTextSpoolResult>;
  dispose(): Promise<void>;
}
interface CurrentObject {
  readonly group: string;
  readonly header: string;
  readonly parts: string[];
  readonly pending: PendingLocator[];
  byteLength: number;
}

const objectLogicalPath = (group: string, sha256: string): string => {
  const path = `objects/${group}-${sha256}.md`;
  validatePortableRelativePath(path);
  return path;
};
const spoolPathFor = (root: string, logicalPath: string): string => join(root, ...logicalPath.split('/'));
const uniqueObjectPaths = (locators: readonly SourceTextLocatorV2[]): readonly string[] =>
  Object.freeze([...new Set(locators.map(locator => locator.objectPath))].sort(compareStrings));

const legacyDetails = (file: StoredFile, locators: readonly SourceTextLocatorV2[]): NonNullable<SnapshotFile['details']> => ({
  group: file.group,
  encoding: file.encoding,
  bom: file.bom,
  lineCount: file.lineCount,
  segments: locators.map(locator => ({
    objectPath: locator.objectPath,
    objectSha256: locator.objectSha256,
    startLine: locator.startLine,
    endLine: locator.endLine,
    segmentIndex: locator.segmentIndex,
    segmentCount: locator.segmentCount,
  })),
});
const v2Details = (file: StoredFile, locators: readonly SourceTextLocatorV2[]): NonNullable<SnapshotFile['details']> => ({
  kind: 'source-text' as const,
  formatVersion: 2 as const,
  normalization: SOURCE_TEXT_NORMALIZATION,
  group: file.group,
  encoding: file.encoding,
  bom: file.bom,
  lineCount: file.lineCount,
  normalizedSha256: file.normalizedSha256,
  normalizedByteLength: file.normalizedByteLength,
  finalNewline: file.finalNewline,
  rawReconstruction: 'not-provided' as const,
  segments: locators.map(locator => ({
    objectPath: locator.objectPath,
    objectSha256: locator.objectSha256,
    bodyByteOffset: locator.bodyByteOffset,
    bodyByteLength: locator.bodyByteLength,
    sourceByteOffset: locator.sourceByteOffset,
    segmentIndex: locator.segmentIndex,
    segmentCount: locator.segmentCount,
    startLine: locator.startLine,
    endLine: locator.endLine,
  })),
});

const makeSnapshotFile = (
  file: StoredFile,
  locators: readonly SourceTextLocatorV2[],
  formatVersion: SourceTextFormatVersion,
): SnapshotFile => Object.freeze({
  path: file.path,
  sha256: file.sha256,
  byteLength: file.byteLength,
  objectPaths: uniqueObjectPaths(locators),
  details: formatVersion === 2 ? v2Details(file, locators) : legacyDetails(file, locators),
});

const contentSpoolPath = async (root: string, contentKey: string): Promise<string> => {
  const integrity = await calculateBytesIntegrity(encoder.encode(contentKey));
  return join(root, 'content', `${integrity.sha256}.txt`);
};
export interface CreateSourceTextSpoolBuilderOptions {
  readonly spoolRoot: string;
  readonly pack: SourceTextPackOptions;
}

export const createSourceTextSpoolBuilder = async (
  options: CreateSourceTextSpoolBuilderOptions,
): Promise<SourceTextSpoolBuilder> => {
  const formatVersion = validateSourceTextPackOptions(options.pack);
  const spoolRoot = options.spoolRoot;
  await mkdir(spoolRoot, { recursive: true });
  if ((await readdir(spoolRoot)).length > 0) throw new SourceSnapshotError('OUTPUT_NOT_EMPTY', { path: spoolRoot });
  await Promise.all([
    mkdir(join(spoolRoot, 'content'), { recursive: true }),
    mkdir(join(spoolRoot, 'objects'), { recursive: true }),
  ]);

  const files: StoredFile[] = [];
  const blocks = new Map<string, StoredBlock>();
  const locatorsByContentKey = new Map<string, LocatorRecord[]>();
  const seenPaths = new Set<string>();
  const foldedPaths = new Set<string>();
  let logicalSourceBytes = 0;
  let uniqueNormalizedBodyBytes = 0;
  let completed: SourceTextSpoolResult | null = null;
  let disposed = false;
  const assertWritable = (): void => {
    if (disposed) throw new SourceSnapshotError('INVALID_INPUT', { field: 'spoolState' });
    if (completed !== null) throw new SourceSnapshotError('INVALID_INPUT', { field: 'spoolFinished' });
  };
  const newCurrent = (group: string): CurrentObject => {
    const header = renderSourceTextObjectHeader(group);
    return { group, header, parts: [], pending: [], byteLength: encoder.encode(header).byteLength };
  };
  const objects: PreparedSourceTextObject[] = [];
  let objectContainerBytes = 0;

  const flushObject = async (current: CurrentObject | null): Promise<void> => {
    if (current === null || current.parts.length === 0) return;
    const content = `${current.header}${current.parts.join('\n')}`;
    const bytes = encoder.encode(content);
    if (bytes.byteLength > options.pack.maxObjectBytes) {
      throw new SourceSnapshotError('PACK_OBJECT_TOO_LARGE', { group: current.group });
    }
    const integrity = await calculateBytesIntegrity(bytes);
    const path = objectLogicalPath(current.group, integrity.sha256);
    const spoolPath = spoolPathFor(spoolRoot, path);
    await mkdir(dirname(spoolPath), { recursive: true });
    await writeFile(spoolPath, bytes);
    objects.push(Object.freeze({ path, sha256: integrity.sha256, byteLength: integrity.byteLength, spoolPath }));
    objectContainerBytes += integrity.byteLength;
    if (objects.length > options.pack.maxObjectCount || objectContainerBytes > options.pack.maxObjectBytesTotal) {
      throw new SourceSnapshotError('PACK_BUDGET_EXCEEDED', {
        objectCount: objects.length,
        objectBytes: objectContainerBytes,
      });
    }
    for (const pending of current.pending) {
      const locators = locatorsByContentKey.get(pending.contentKey);
      if (locators === undefined) throw new SourceSnapshotError('COVERAGE_INVALID');
      locators.push(Object.freeze({
        objectPath: path,
        objectSha256: integrity.sha256,
        bodyByteOffset: pending.bodyByteOffset,
        bodyByteLength: pending.bodyByteLength,
        sourceByteOffset: pending.sourceByteOffset,
        segmentIndex: pending.segmentIndex,
        segmentCount: pending.segmentCount,
        startLine: pending.startLine,
        endLine: pending.endLine,
      }));
    }
  };

  const add = async (file: StagedSourceTextFile): Promise<void> => {
    assertWritable();
    try { validatePortableRelativePath(file.path); }
    catch { throw new SourceSnapshotError('INVALID_INPUT', { field: 'path' }); }
    if (seenPaths.has(file.path)) throw new SourceSnapshotError('DUPLICATE_PATH', { path: file.path });
    const folded = file.path.toLowerCase();
    if (foldedPaths.has(folded)) throw new SourceSnapshotError('CASE_COLLISION', { path: file.path });
    seenPaths.add(file.path); foldedPaths.add(folded);

    const contentKey = sourceTextContentKey(file, formatVersion);
    const stored: StoredFile = Object.freeze({
      path: file.path, group: file.group, sha256: file.sha256, byteLength: file.byteLength,
      encoding: file.encoding, bom: file.bom, lineCount: file.lineCount,
      normalizedSha256: file.normalizedSha256, normalizedByteLength: file.normalizedByteLength,
      finalNewline: file.finalNewline, contentKey,
    });
    files.push(stored);
    logicalSourceBytes += file.byteLength;
    if (!blocks.has(contentKey)) {
      const bodySpoolPath = await contentSpoolPath(spoolRoot, contentKey);
      await writeFile(bodySpoolPath, file.text, 'utf8');
      blocks.set(contentKey, Object.freeze({
        path: file.path,
        group: file.group,
        sha256: file.sha256,
        byteLength: file.byteLength,
        encoding: file.encoding,
        bom: file.bom,
        lineCount: file.lineCount,
        normalizedSha256: file.normalizedSha256,
        normalizedByteLength: file.normalizedByteLength,
        finalNewline: file.finalNewline,
        contentKey,
        bodySpoolPath,
      }));
      locatorsByContentKey.set(contentKey, []);
      uniqueNormalizedBodyBytes += file.normalizedByteLength;
    }
  };

  const appendSegment = async (
    segment: ReturnType<typeof splitSourceTextFile>[number],
    current: CurrentObject | null,
  ): Promise<CurrentObject> => {
    let target = current ?? newCurrent(segment.file.group);
    if (target.group !== segment.file.group) {
      await flushObject(target);
      target = newCurrent(segment.file.group);
    }
    const rendered = renderSourceTextObjectSection(sourceTextObjectInputForSegment(segment, formatVersion));
    const separatorBytes = target.parts.length > 0 ? 1 : 0;
    const candidateBytes = target.byteLength + separatorBytes + rendered.byteLength;
    if (target.parts.length > 0 && candidateBytes > options.pack.targetObjectBytes) {
      await flushObject(target);
      target = newCurrent(segment.file.group);
    }
    const separator = target.parts.length > 0 ? 1 : 0;
    const baseOffset = target.byteLength + separator;
    const finalBytes = baseOffset + rendered.byteLength;
    if (finalBytes > options.pack.maxObjectBytes) {
      throw new SourceSnapshotError('PACK_OBJECT_TOO_LARGE', { path: segment.file.path });
    }
    if (separator > 0) target.byteLength += 1;
    target.pending.push(Object.freeze({
      contentKey: segment.contentKey,
      bodyByteOffset: target.byteLength + rendered.bodyOffset,
      bodyByteLength: rendered.bodyLength,
      sourceByteOffset: segment.sourceByteOffset,
      segmentIndex: segment.segmentIndex,
      segmentCount: segment.segmentCount,
      startLine: segment.startLine,
      endLine: segment.endLine,
    }));
    target.parts.push(rendered.content);
    target.byteLength += rendered.byteLength;
    return target;
  };

  const finish = async (): Promise<SourceTextSpoolResult> => {
    if (disposed) throw new SourceSnapshotError('INVALID_INPUT', { field: 'spoolState' });
    if (completed !== null) return completed;
    let current: CurrentObject | null = null;
    const orderedBlocks = [...blocks.values()].sort((a, b) =>
      compareStrings(a.group, b.group) || compareStrings(a.contentKey, b.contentKey));
    for (const block of orderedBlocks) {
      const text = await readFile(block.bodySpoolPath, 'utf8');
      const staged: StagedSourceTextFile = Object.freeze({
        path: block.path,
        group: block.group,
        sha256: block.sha256,
        byteLength: block.byteLength,
        text,
        encoding: block.encoding,
        bom: block.bom,
        lineCount: block.lineCount,
        normalizedSha256: block.normalizedSha256,
        normalizedByteLength: block.normalizedByteLength,
        finalNewline: block.finalNewline,
      });
      for (const segment of splitSourceTextFile(staged, options.pack.maxObjectBytes, block.contentKey)) {
        current = await appendSegment(segment, current);
      }
      await rm(block.bodySpoolPath, { force: true });
    }
    await flushObject(current);
    await rm(join(spoolRoot, 'content'), { recursive: true, force: true });

    const snapshotFiles = files
      .map(file => {
        const locators = locatorsByContentKey.get(file.contentKey);
        if (locators === undefined || locators.length === 0) {
          throw new SourceSnapshotError('COVERAGE_INVALID', { path: file.path });
        }
        const ordered = Object.freeze([...locators].sort((a, b) => a.segmentIndex - b.segmentIndex));
        return makeSnapshotFile(file, ordered, formatVersion);
      })
      .sort((a, b) => compareStrings(a.path, b.path));
    completed = Object.freeze({
      files: Object.freeze(snapshotFiles),
      objects: Object.freeze([...objects]),
      metrics: Object.freeze({
        logicalSourceBytes,
        uniqueNormalizedBodyBytes,
        objectContainerBytes,
      }),
    });
    return completed;
  };

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    await rm(spoolRoot, { recursive: true, force: true });
  };

  return Object.freeze({ add, finish, dispose });
};
