import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  buildSourceTextPackage,
  createTextSnapshotManifest,
  stageSourceTextFile,
} from '../../src/index.js';
import type { SourceTextDetails, SourceTextDetailsV2 } from '../../src/index.js';
import { parseSourceTextDetails } from '../../src/text-format.js';

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
const sha256 = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
const required = <T>(value: T | undefined, label: string): T => {
  if (value === undefined) throw new Error('missing fixture ' + label);
  return value;
};
const assertV2: (details: SourceTextDetails) => asserts details is SourceTextDetailsV2 = (details) => {
  expect(details.formatVersion).toBe(2);
  if (details.formatVersion !== 2) throw new Error('expected source text details v2');
};
const packV2 = {
  targetObjectBytes: 4096,
  maxObjectBytes: 8192,
  maxObjectCount: 50,
  maxObjectBytesTotal: 500_000,
  textFormatVersion: 2 as const,
};

const manifestFor = async (path: string, bytes: Uint8Array, group = 'code') => {
  const staged = await stageSourceTextFile({ path, group, bytes });
  const packed = await buildSourceTextPackage([staged], packV2);
  const manifest = await createTextSnapshotManifest({
    projectId: 'format-v2-fixture', policyVersion: '2', publishedAt: 1,
    repositories: [], textPackage: packed,
  });
  return { staged, packed, manifest, file: required(manifest.files[0], 'manifest file') };
};

test.each([
  ['lf', '一\n二\n', '一\n二\n'],
  ['crlf', '一\r\n二\r\n', '一\n二\n'],
  ['cr', '一\r二\r', '一\n二\n'],
  ['mixed-no-final', '一\r\n二\r三🙂', '一\n二\n三🙂'],
])('v2 records raw and normalized integrity for %s input', async (_name, raw, normalized) => {
  const bytes = utf8(raw);
  const { staged, file } = await manifestFor('src/value.ts', bytes);
  const details = parseSourceTextDetails(file.details);
  assertV2(details);

  expect(details.formatVersion).toBe(2);
  expect(details.normalization).toBe('decoded-lf-utf8-v1');
  expect(details.normalizedByteLength).toBe(utf8(normalized).byteLength);
  expect(details.normalizedSha256).toBe(sha256(utf8(normalized)));
  expect(details.finalNewline).toBe(normalized.endsWith('\n'));
  expect(staged.sha256).toBe(sha256(bytes));
  expect(staged.normalizedSha256).toBe(details.normalizedSha256);
  expect(staged.normalizedByteLength).toBe(details.normalizedByteLength);
  expect(details.rawReconstruction).toBe('not-provided');
});

test('v2 preserves BOM and decoded encoding while hashing normalized UTF-8 text', async () => {
  const bytes = Uint8Array.from([0xff, 0xfe, 0x41, 0x00, 0x0d, 0x00, 0x0a, 0x00, 0x42, 0x00]);
  const { file } = await manifestFor('src/utf16.txt', bytes);
  const details = parseSourceTextDetails(file.details);
  assertV2(details);
  expect(details.encoding).toBe('utf16le');
  expect(details.bom).toBe('utf16le');
  expect(details.normalizedSha256).toBe(sha256(utf8('A\nB')));
});

test('v2 locators identify exact Markdown body bytes without container newline', async () => {
  const source = `before\n${'`'.repeat(7)}\n中文🙂after`;
  const { packed, file } = await manifestFor('docs/fence.md', utf8(source), 'docs');
  const details = parseSourceTextDetails(file.details);
  assertV2(details);
  const objectByPath = new Map(packed.objects.map(object => [object.path, object]));
  let expectedSourceOffset = 0;

  for (const locator of details.segments) {
    const object = required(objectByPath.get(locator.objectPath), 'packed object');
    const objectBytes = utf8(object.content);
    const body = objectBytes.slice(locator.bodyByteOffset, locator.bodyByteOffset + locator.bodyByteLength);
    const segment = required(required(packed.files[0], 'packed file').segments[locator.segmentIndex - 1], 'packed segment');
    expect(new TextDecoder('utf-8', { fatal: true }).decode(body)).toBe(segment.text);
    expect(locator.bodyByteLength).toBe(utf8(segment.text).byteLength);
    expect(locator.sourceByteOffset).toBe(expectedSourceOffset);
    expectedSourceOffset += locator.bodyByteLength;
  }
  expect(expectedSourceOffset).toBe(details.normalizedByteLength);
});

test('v2 supports empty files and multiple pieces of one oversized source line', async () => {
  const empty = await manifestFor('src/empty.ts', new Uint8Array());
  const emptyDetails = parseSourceTextDetails(empty.file.details);
  assertV2(emptyDetails);
  expect(emptyDetails.normalizedByteLength).toBe(0);
  expect(emptyDetails.segments).toHaveLength(1);
  expect(emptyDetails.segments[0]).toMatchObject({ bodyByteLength: 0, sourceByteOffset: 0, startLine: 0, endLine: 0 });

  const text = `+${'🙂'.repeat(1800)}`;
  const staged = await stageSourceTextFile({ path: 'patches/large.patch', group: 'patches', bytes: utf8(text) });
  const packed = await buildSourceTextPackage([staged], { ...packV2, targetObjectBytes: 2048, maxObjectBytes: 4096 });
  const manifest = await createTextSnapshotManifest({ projectId: 'long-line', policyVersion: '2', publishedAt: 1, repositories: [], textPackage: packed });
  const details = parseSourceTextDetails(required(manifest.files[0], 'manifest file').details);
  assertV2(details);
  expect(details.segments.length).toBeGreaterThan(1);
  expect(new Set(details.segments.map(segment => segment.startLine))).toEqual(new Set([1]));
  expect(details.segments.map(segment => segment.sourceByteOffset)).toEqual(
    details.segments.map((_, index) => details.segments.slice(0, index).reduce((sum, item) => sum + item.bodyByteLength, 0)),
  );
});

test('legacy text details remain explicit v1 and unknown versions fail closed', async () => {
  const staged = await stageSourceTextFile({ path: 'src/legacy.ts', group: 'code', bytes: utf8('legacy\n') });
  const packed = await buildSourceTextPackage([staged], {
    targetObjectBytes: 4096, maxObjectBytes: 8192, maxObjectCount: 10, maxObjectBytesTotal: 100_000,
  });
  const manifest = await createTextSnapshotManifest({
    projectId: 'legacy-fixture', policyVersion: '1', publishedAt: 1,
    repositories: [], textPackage: packed,
  });
  const legacy = parseSourceTextDetails(required(manifest.files[0], 'manifest file').details);
  expect(legacy).toMatchObject({ kind: 'source-text', formatVersion: 1, group: 'code', lineCount: 1 });

  expect(() => parseSourceTextDetails({
    kind: 'source-text',
    formatVersion: 99,
    group: 'code',
    encoding: 'utf8',
    bom: null,
    lineCount: 1,
    segments: [],
  })).toThrowError(expect.objectContaining({ code: 'TEXT_FORMAT_UNSUPPORTED' }));
});

test('v2 preserves UTF-16BE BOM and normalized UTF-8 integrity', async () => {
  const bytes = Uint8Array.from([0xfe, 0xff, 0x00, 0x41, 0x00, 0x0d, 0x00, 0x0a, 0x00, 0x42]);
  const { file } = await manifestFor('src/utf16be.txt', bytes);
  const details = parseSourceTextDetails(file.details);
  assertV2(details);
  expect(details.encoding).toBe('utf16be');
  expect(details.bom).toBe('utf16be');
  expect(details.normalizedSha256).toBe(sha256(utf8('A\nB')));
});

test('v2 rejects an object when fixed container overhead alone exceeds maxObjectBytes', async () => {
  const staged = await stageSourceTextFile({ path: 'src/tiny.ts', group: 'code', bytes: utf8('x') });
  await expect(buildSourceTextPackage([staged], {
    targetObjectBytes: 64, maxObjectBytes: 128, maxObjectCount: 10,
    maxObjectBytesTotal: 100_000, textFormatVersion: 2,
  })).rejects.toMatchObject({ code: 'PACK_OBJECT_TOO_LARGE' });
});
