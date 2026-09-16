import type { JsonValue } from '@openge/forge-deterministic-json';
import type { DecodedSourceText, SourceTextDetails, SourceTextLocatorV2 } from './content-contracts.js';
import { SourceSnapshotError } from './errors.js';
import { SOURCE_TEXT_NORMALIZATION } from './text-integrity.js';

const encodings = new Set<DecodedSourceText['encoding']>(['utf8', 'utf16le', 'utf16be']);
const boms = new Set<DecodedSourceText['bom']>([null, 'utf8', 'utf16le', 'utf16be']);
const hashPattern = /^[a-f0-9]{64}$/u;

const invalid = (field: string): never => { throw new SourceSnapshotError('TEXT_DETAILS_INVALID', { field }); };
const record = (value: unknown, field: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(field);
  return value as Record<string, unknown>;
};
const string = (value: unknown, field: string): string => typeof value === 'string' && value.length > 0 ? value : invalid(field);
const count = (value: unknown, field: string): number => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : invalid(field);
const encoding = (value: unknown): DecodedSourceText['encoding'] => encodings.has(value as DecodedSourceText['encoding']) ? value as DecodedSourceText['encoding'] : invalid('encoding');
const bom = (value: unknown): DecodedSourceText['bom'] => boms.has(value as DecodedSourceText['bom']) ? value as DecodedSourceText['bom'] : invalid('bom');
const segments = (value: unknown): readonly Readonly<Record<string, unknown>>[] => {
  if (!Array.isArray(value) || value.length === 0) invalid('segments');
  const values = value as unknown[];
  return Object.freeze(values.map((item: unknown, index: number) => Object.freeze({ ...record(item, `segments.${index}`) })));
};

const parseLocator = (value: unknown, index: number): SourceTextLocatorV2 => {
  const item = record(value, `segments.${index}`);
  const objectSha256 = string(item.objectSha256, `segments.${index}.objectSha256`);
  if (!hashPattern.test(objectSha256)) invalid(`segments.${index}.objectSha256`);
  const segmentIndex = count(item.segmentIndex, `segments.${index}.segmentIndex`);
  const segmentCount = count(item.segmentCount, `segments.${index}.segmentCount`);
  if (segmentIndex < 1 || segmentCount < 1 || segmentIndex > segmentCount) invalid(`segments.${index}.segmentIndex`);
  const startLine = count(item.startLine, `segments.${index}.startLine`);
  const endLine = count(item.endLine, `segments.${index}.endLine`);
  if (endLine < startLine) invalid(`segments.${index}.endLine`);
  return Object.freeze({
    objectPath: string(item.objectPath, `segments.${index}.objectPath`),
    objectSha256,
    bodyByteOffset: count(item.bodyByteOffset, `segments.${index}.bodyByteOffset`),
    bodyByteLength: count(item.bodyByteLength, `segments.${index}.bodyByteLength`),
    sourceByteOffset: count(item.sourceByteOffset, `segments.${index}.sourceByteOffset`),
    segmentIndex,
    segmentCount,
    startLine,
    endLine,
  });
};

export const parseSourceTextDetails = (value: JsonValue | undefined): SourceTextDetails => {
  const input = record(value, 'details');
  if (input.formatVersion === undefined && input.kind === undefined) {
    return Object.freeze({
      kind: 'source-text' as const,
      formatVersion: 1 as const,
      group: string(input.group, 'group'),
      encoding: encoding(input.encoding),
      bom: bom(input.bom),
      lineCount: count(input.lineCount, 'lineCount'),
      segments: segments(input.segments),
    });
  }

  if (input.kind !== 'source-text') invalid('kind');
  if (input.formatVersion !== 2) {
    throw new SourceSnapshotError('TEXT_FORMAT_UNSUPPORTED', { formatVersion: input.formatVersion });
  }
  if (input.normalization !== SOURCE_TEXT_NORMALIZATION) invalid('normalization');
  const normalizedSha256 = string(input.normalizedSha256, 'normalizedSha256');
  if (!hashPattern.test(normalizedSha256)) invalid('normalizedSha256');
  const finalNewline = typeof input.finalNewline === 'boolean' ? input.finalNewline : invalid('finalNewline');
  if (input.rawReconstruction !== 'not-provided') invalid('rawReconstruction');
  const locatorValues = Array.isArray(input.segments) ? input.segments as unknown[] : invalid('segments');
  if (locatorValues.length === 0) invalid('segments');

  return Object.freeze({
    kind: 'source-text' as const,
    formatVersion: 2 as const,
    normalization: SOURCE_TEXT_NORMALIZATION,
    group: string(input.group, 'group'),
    encoding: encoding(input.encoding),
    bom: bom(input.bom),
    lineCount: count(input.lineCount, 'lineCount'),
    normalizedSha256,
    normalizedByteLength: count(input.normalizedByteLength, 'normalizedByteLength'),
    finalNewline,
    rawReconstruction: 'not-provided' as const,
    segments: Object.freeze(locatorValues.map((item: unknown, index: number) => parseLocator(item, index))),
  });
};
