import { calculateBytesIntegrity } from '@openge/forge-artifact-integrity';
import { validatePortableRelativePath } from '@openge/forge-path-safety';
import type {
  PackedSourceTextFile,
  PackedSourceTextObject,
  SourceTextFormatVersion,
  SourceTextPackage,
  SourceTextPackOptions,
  SourceTextSegment,
  StageSourceTextFileInput,
  StagedSourceTextFile,
} from './content-contracts.js';
import { planSourceTextContentDedup } from './content-dedup.js';
import { SourceSnapshotError } from './errors.js';
import { decodeSourceText } from './text.js';
import { calculateNormalizedTextIntegrity, normalizeDecodedSourceText, SOURCE_TEXT_NORMALIZATION } from './text-integrity.js';
import { renderSourceTextObject, type SourceTextObjectSectionInput } from './text-object-renderer.js';
import { compareStrings, uniquePaths } from './validation.js';

interface RawSegment {
  readonly file: StagedSourceTextFile;
  readonly contentKey: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly segmentIndex: number;
  readonly segmentCount: number;
  readonly sourceByteOffset: number;
  readonly text: string;
  objectPath?: string;
  objectSha256?: string;
  bodyByteOffset?: number;
  bodyByteLength?: number;
}

const encoder = new TextEncoder();
const byteLength = (value: string): number => encoder.encode(value).byteLength;
const splitLines = (text: string): readonly string[] => {
  if (text.length === 0) return [];
  const result: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      result.push(text.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < text.length) result.push(text.slice(start));
  return result;
};
const lineCount = (text: string): number => splitLines(text).length;
const assertGroup = (group: string): string => {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(group)) throw new SourceSnapshotError('INVALID_GROUP', { group });
  return group;
};

export const stageSourceTextFile = async (input: StageSourceTextFileInput): Promise<StagedSourceTextFile> => {
  try { validatePortableRelativePath(input.path); } catch { throw new SourceSnapshotError('INVALID_INPUT', { field: 'path' }); }
  const group = assertGroup(input.group);
  if (!(input.bytes instanceof Uint8Array)) throw new SourceSnapshotError('INVALID_INPUT', { field: 'bytes' });
  const bytes = Uint8Array.from(input.bytes);
  const decoded = decodeSourceText(bytes);
  const rawIntegrity = await calculateBytesIntegrity(bytes);
  const text = normalizeDecodedSourceText(decoded.text);
  const normalized = await calculateNormalizedTextIntegrity(text);
  return Object.freeze({
    path: input.path,
    group,
    sha256: rawIntegrity.sha256,
    byteLength: rawIntegrity.byteLength,
    text,
    encoding: decoded.encoding,
    bom: decoded.bom,
    lineCount: lineCount(text),
    normalizedSha256: normalized.normalizedSha256,
    normalizedByteLength: normalized.normalizedByteLength,
    finalNewline: normalized.finalNewline,
  });
};

const splitUtf8 = (text: string, maxBytes: number): readonly string[] => {
  if (byteLength(text) <= maxBytes) return [text];
  const result: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const character of text) {
    const size = byteLength(character);
    if (size > maxBytes) throw new SourceSnapshotError('PACK_OBJECT_TOO_LARGE');
    if (current.length > 0 && currentBytes + size > maxBytes) {
      result.push(current);
      current = '';
      currentBytes = 0;
    }
    current += character;
    currentBytes += size;
  }
  if (current.length > 0) result.push(current);
  return result;
};

const splitFile = (file: StagedSourceTextFile, maxObjectBytes: number, contentKey: string): RawSegment[] => {
  const lines = splitLines(file.text);
  if (lines.length === 0) {
    return [{ file, contentKey, startLine: 0, endLine: 0, segmentIndex: 1, segmentCount: 1, sourceByteOffset: 0, text: '' }];
  }
  const maxTextBytes = Math.max(1, maxObjectBytes - 1536);
  const raw: Array<{ startLine: number; endLine: number; text: string }> = [];
  let buffered: Array<{ line: number; text: string }> = [];
  let size = 0;
  const flush = (): void => {
    if (buffered.length === 0) return;
    const first = buffered[0];
    const last = buffered.at(-1);
    if (first === undefined || last === undefined) throw new SourceSnapshotError('COVERAGE_INVALID');
    raw.push({ startLine: first.line, endLine: last.line, text: buffered.map(value => value.text).join('') });
    buffered = [];
    size = 0;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) throw new SourceSnapshotError('COVERAGE_INVALID');
    const number = index + 1;
    const bytes = byteLength(line);
    if (bytes > maxTextBytes) {
      flush();
      for (const chunk of splitUtf8(line, maxTextBytes)) raw.push({ startLine: number, endLine: number, text: chunk });
      continue;
    }
    if (buffered.length > 0 && size + bytes > maxTextBytes) flush();
    buffered.push({ line: number, text: line });
    size += bytes;
  }
  flush();
  let sourceByteOffset = 0;
  return raw.map((value, index) => {
    const segment = {
      file, contentKey, ...value, segmentIndex: index + 1, segmentCount: raw.length, sourceByteOffset,
    };
    sourceByteOffset += byteLength(value.text);
    return segment;
  });
};

const sectionInput = (segment: RawSegment): SourceTextObjectSectionInput => ({
  formatVersion: 1,
  path: segment.file.path,
  group: segment.file.group,
  sourceSha256: segment.file.sha256,
  sourceByteLength: segment.file.byteLength,
  encoding: segment.file.encoding,
  bom: segment.file.bom,
  startLine: segment.startLine,
  endLine: segment.endLine,
  segmentIndex: segment.segmentIndex,
  segmentCount: segment.segmentCount,
  text: segment.text,
});
const contentBlockInput = (segment: RawSegment): SourceTextObjectSectionInput => ({
  formatVersion: 2,
  group: segment.file.group,
  sourceSha256: segment.file.sha256,
  sourceByteLength: segment.file.byteLength,
  normalization: SOURCE_TEXT_NORMALIZATION,
  normalizedSha256: segment.file.normalizedSha256,
  normalizedByteLength: segment.file.normalizedByteLength,
  encoding: segment.file.encoding,
  bom: segment.file.bom,
  startLine: segment.startLine,
  endLine: segment.endLine,
  segmentIndex: segment.segmentIndex,
  segmentCount: segment.segmentCount,
  text: segment.text,
});
const renderInputs = (segments: readonly RawSegment[], formatVersion: SourceTextFormatVersion) =>
  segments.map(segment => formatVersion === 2 ? contentBlockInput(segment) : sectionInput(segment));
const renderObject = (group: string, segments: readonly RawSegment[], formatVersion: SourceTextFormatVersion): string =>
  renderSourceTextObject(group, renderInputs(segments, formatVersion)).content;

const validateOptions = (options: SourceTextPackOptions): SourceTextFormatVersion => {
  for (const field of ['targetObjectBytes', 'maxObjectBytes', 'maxObjectCount', 'maxObjectBytesTotal'] as const) {
    const value = options[field];
    if (!Number.isSafeInteger(value) || value < 0) throw new SourceSnapshotError('INVALID_INPUT', { field });
  }
  if (options.targetObjectBytes === 0 || options.maxObjectBytes === 0 || options.targetObjectBytes > options.maxObjectBytes) {
    throw new SourceSnapshotError('INVALID_INPUT', { field: 'objectBytes' });
  }
  const version = options.textFormatVersion ?? 1;
  if (version !== 1 && version !== 2) throw new SourceSnapshotError('INVALID_INPUT', { field: 'textFormatVersion' });
  return version;
};

const finalizeObject = async (
  group: string,
  segments: readonly RawSegment[],
  maxObjectBytes: number,
  formatVersion: SourceTextFormatVersion,
): Promise<PackedSourceTextObject> => {
  const rendered = renderSourceTextObject(group, renderInputs(segments, formatVersion));
  const bytes = encoder.encode(rendered.content);
  if (bytes.byteLength > maxObjectBytes) throw new SourceSnapshotError('PACK_OBJECT_TOO_LARGE', { group });
  const integrity = await calculateBytesIntegrity(bytes);
  const path = `objects/${group}-${integrity.sha256}.md`;
  validatePortableRelativePath(path);
  segments.forEach((segment, index) => {
    const location = rendered.locations[index];
    if (location === undefined) throw new SourceSnapshotError('COVERAGE_INVALID', { path: segment.file.path });
    segment.objectPath = path;
    segment.objectSha256 = integrity.sha256;
    if (formatVersion === 2) {
      segment.bodyByteOffset = location.bodyByteOffset;
      segment.bodyByteLength = location.bodyByteLength;
    }
  });
  return Object.freeze({ path, sha256: integrity.sha256, byteLength: integrity.byteLength, group, content: rendered.content });
};

export const buildSourceTextPackage = async (
  input: readonly StagedSourceTextFile[],
  options: SourceTextPackOptions,
): Promise<SourceTextPackage> => {
  const formatVersion = validateOptions(options);
  uniquePaths(input.map(value => value.path));
  const files = [...input].sort((a, b) => compareStrings(a.path, b.path));
  const dedup = planSourceTextContentDedup(files, formatVersion);
  const raw = dedup.blocks
    .flatMap(block => splitFile(block.file, options.maxObjectBytes, block.key))
    .sort((a, b) => compareStrings(a.file.group, b.file.group) || compareStrings(a.contentKey, b.contentKey) || a.segmentIndex - b.segmentIndex);
  const groups = new Map<string, RawSegment[]>();
  for (const segment of raw) {
    const values = groups.get(segment.file.group) ?? [];
    values.push(segment);
    groups.set(segment.file.group, values);
  }

  const objects: PackedSourceTextObject[] = [];
  for (const [group, segments] of [...groups.entries()].sort(([a], [b]) => compareStrings(a, b))) {
    let current: RawSegment[] = [];
    for (const segment of segments) {
      const candidate = [...current, segment];
      if (current.length > 0 && byteLength(renderObject(group, candidate, formatVersion)) > options.targetObjectBytes) {
        objects.push(await finalizeObject(group, current, options.maxObjectBytes, formatVersion));
        current = [segment];
      } else {
        current = candidate;
      }
      if (byteLength(renderObject(group, current, formatVersion)) > options.maxObjectBytes) {
        throw new SourceSnapshotError('PACK_OBJECT_TOO_LARGE', { path: segment.file.path });
      }
    }
    if (current.length > 0) objects.push(await finalizeObject(group, current, options.maxObjectBytes, formatVersion));
  }

  const total = objects.reduce((sum, value) => sum + value.byteLength, 0);
  if (objects.length > options.maxObjectCount || total > options.maxObjectBytesTotal) {
    throw new SourceSnapshotError('PACK_BUDGET_EXCEEDED', { objectCount: objects.length, objectBytes: total });
  }

  const packedFiles: PackedSourceTextFile[] = files.map(file => {
    const contentKey = dedup.blockKeyByPath.get(file.path);
    if (contentKey === undefined) throw new SourceSnapshotError('COVERAGE_INVALID', { path: file.path });
    const segments = raw.filter(value => value.contentKey === contentKey).map(value => {
      if (value.objectPath === undefined || value.objectSha256 === undefined) {
        throw new SourceSnapshotError('COVERAGE_INVALID', { path: file.path });
      }
      return Object.freeze({
        objectPath: value.objectPath,
        objectSha256: value.objectSha256,
        startLine: value.startLine,
        endLine: value.endLine,
        segmentIndex: value.segmentIndex,
        segmentCount: value.segmentCount,
        text: value.text,
        ...(formatVersion === 2
          ? {
              bodyByteOffset: value.bodyByteOffset,
              bodyByteLength: value.bodyByteLength,
              sourceByteOffset: value.sourceByteOffset,
            }
          : {}),
      });
    });
    return Object.freeze({
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
      textFormatVersion: formatVersion,
      segments: Object.freeze(segments),
    });
  });
  return Object.freeze({
    objects: Object.freeze(objects),
    files: Object.freeze(packedFiles),
    metrics: Object.freeze({
      logicalSourceBytes: dedup.logicalSourceBytes,
      uniqueNormalizedBodyBytes: dedup.uniqueNormalizedBodyBytes,
      objectContainerBytes: total,
    }),
  });
};

const assertCoverage = (
  value: PackedSourceTextFile,
  objects: ReadonlyMap<string, PackedSourceTextObject>,
): readonly SourceTextSegment[] => {
  const segments = [...value.segments].sort((a, b) => a.segmentIndex - b.segmentIndex);
  if (segments.length === 0 || segments.length !== (segments[0]?.segmentCount ?? 0)) {
    throw new SourceSnapshotError('COVERAGE_INVALID', { path: value.path });
  }
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined || segment.segmentIndex !== index + 1 || segment.endLine < segment.startLine) {
      throw new SourceSnapshotError('COVERAGE_INVALID', { path: value.path });
    }
    const object = objects.get(segment.objectPath);
    if (object === undefined || object.sha256 !== segment.objectSha256) {
      throw new SourceSnapshotError('COVERAGE_INVALID', { path: value.path });
    }
    if (index === 0) {
      if (value.lineCount === 0
        ? (segment.startLine !== 0 || segment.endLine !== 0 || segment.text !== '')
        : segment.startLine !== 1) {
        throw new SourceSnapshotError('COVERAGE_INVALID', { path: value.path });
      }
      continue;
    }
    const previous = segments[index - 1];
    if (previous === undefined) throw new SourceSnapshotError('COVERAGE_INVALID', { path: value.path });
    const same = segment.startLine === previous.endLine;
    const next = segment.startLine === previous.endLine + 1;
    if ((!same && !next) || (same && previous.text.endsWith('\n')) || (next && !previous.text.endsWith('\n'))) {
      throw new SourceSnapshotError('COVERAGE_INVALID', { path: value.path });
    }
  }
  if (value.lineCount > 0 && segments.at(-1)?.endLine !== value.lineCount) {
    throw new SourceSnapshotError('COVERAGE_INVALID', { path: value.path });
  }
  return segments;
};

export const reconstructSourceText = (value: SourceTextPackage, path: string): string => {
  const file = value.files.find(candidate => candidate.path === path);
  if (file === undefined) throw new SourceSnapshotError('FILE_NOT_PACKED', { path });
  const objects = new Map(value.objects.map(object => [object.path, object]));
  const segments = assertCoverage(file, objects);
  const text = segments.map(segment => segment.text).join('');
  if (lineCount(text) !== file.lineCount) throw new SourceSnapshotError('COVERAGE_INVALID', { path });
  return text;
};
