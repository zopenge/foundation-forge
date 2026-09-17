import { afterEach, expect, test, vi } from 'vitest';
afterEach(() => vi.restoreAllMocks());
import {
  buildSnapshotReadIndex, buildSnapshotReadView, buildSnapshotReadProfileView,
  buildSourceTextPackage, createTextSnapshotManifest, createSnapshotManifest,
  readSnapshotText, stageSourceTextFile,
} from '../src/index.js';
import { parseSourceTextDetails } from '../src/text-format.js';
import * as readBytes from '../src/read-bytes.js';
import { renderSnapshotReadIndexMarkdown } from '../src/read-index.js';

const utf8 = (text: string) => new TextEncoder().encode(text);
const limits = { maxObjectBytes: 8192, maxFileBytes: 8192, maxTotalBytes: 16384 };
async function fixture() {
  const staged = await stageSourceTextFile({ path: 'src/input.ts', group: 'code', bytes: utf8('export const value = 1;\n') });
  const textPackage = await buildSourceTextPackage([staged], {
    targetObjectBytes: 4096, maxObjectBytes: 8192, maxObjectCount: 10,
    maxObjectBytesTotal: 100_000, textFormatVersion: 2,
  });
  const manifest = await createTextSnapshotManifest({
    projectId: 'read-optimization', policyVersion: 'v2', publishedAt: 1, repositories: [], textPackage,
  });
  const first = textPackage.objects[0];
  if (!first) throw new Error('missing object fixture');
  return { manifest, object: { path: first.path, bytes: utf8(first.content) } };
}

test.each(['index', 'view', 'profile'] as const)('%s uses a bounded number of source-path visits', async operation => {
  const { manifest: base } = await fixture();
  const file = base.files[0]; const object = base.objects[0];
  if (!file || !object) throw new Error('missing manifest fixture');
  const details = parseSourceTextDetails(file.details);
  if (details.formatVersion !== 2) throw new Error('expected v2 fixture');
  const size = 1000;
  const objects = Array.from({ length: Math.ceil(size / 32) }, (_, i) => ({ ...object, path: `objects/fixture-${i}.md` }));
  const files = Array.from({ length: size }, (_, i) => {
    const target = objects[Math.floor(i / 32)];
    if (!target) throw new Error('missing scaled object');
    return { ...file, path: `src/file-${String(i).padStart(5, '0')}.ts`, objectPaths: [target.path],
      details: { ...details, segments: details.segments.map(segment => ({ ...segment, objectPath: target.path })) } };
  });
  const canonical = await createSnapshotManifest({ ...base, files, objects });
  let visits = 0;
  const manifest = { ...canonical, files: canonical.files.map(entry => ({ ...entry, get path() { visits += 1; return entry.path; } })) };
  const path = files.at(-1)?.path;
  if (!path) throw new Error('missing selected path');
  if (operation === 'index') expect(buildSnapshotReadIndex(manifest).fileCount).toBe(size);
  else if (operation === 'view') expect(buildSnapshotReadView(manifest, { viewId: 'one', snapshotId: manifest.snapshotId, paths: [path] }).found).toEqual([path]);
  else expect(buildSnapshotReadProfileView(manifest, { profileId: 'two', snapshotId: manifest.snapshotId, preferredPaths: [path], referencePaths: [path] }).duplicatePaths).toEqual([path]);
  expect(visits).toBeLessThan(size * 20);
});

test.each(['object-limit', 'total-limit', 'actual-limit', 'duplicate', 'unexpected', 'length-mismatch'] as const)('rejects %s before copying supplied bytes', async scenario => {
  const { manifest, object } = await fixture();
  const copies = vi.spyOn(readBytes, 'cloneSnapshotBytes');
  const original = scenario === 'actual-limit' ? new Uint8Array(9000)
    : scenario === 'length-mismatch' ? new Uint8Array(object.bytes.length + 1) : object.bytes;
  const bytes = new Uint8Array(original);
  const supplied = [{ path: object.path, bytes }];
  if (scenario === 'duplicate') supplied.push({ path: object.path, bytes });
  if (scenario === 'unexpected') supplied.push({ path: 'objects/extra.md', bytes });
  const selectedLimits = { ...limits,
    ...(scenario === 'object-limit' ? { maxObjectBytes: 1 } : {}),
    ...(scenario === 'total-limit' ? { maxTotalBytes: 1 } : {}),
  };
  const code = scenario.endsWith('limit') ? 'TEXT_READ_LIMIT_EXCEEDED'
    : scenario === 'length-mismatch' ? 'OBJECT_INTEGRITY_MISMATCH' : 'OBJECT_CONFLICT';
  await expect(readSnapshotText(manifest, supplied, 'src/input.ts', selectedLimits)).rejects.toMatchObject({ code });
  expect(copies).not.toHaveBeenCalled();
});

test('preserves legacy assurance declarations without fabricating verification receipts', async () => {
  const { manifest } = await fixture();
  const index = buildSnapshotReadIndex(manifest);
  expect(index.files[0]?.assurance).toBe('normalized-text-verified');
  expect(index).not.toHaveProperty('observedVerification');
  expect(index.files[0]).not.toHaveProperty('observedVerification');
  expect(index.metrics.renderingLines).toBe(renderSnapshotReadIndexMarkdown(index).split('\n').length - 1);
});

test('rejects duplicate manifest paths instead of silently projecting the first record', async () => {
  const { manifest } = await fixture();
  const file = manifest.files[0];
  if (!file) throw new Error('missing file fixture');
  expect(() => buildSnapshotReadIndex({ ...manifest, files: [file, file] }))
    .toThrowError(expect.objectContaining({ code: 'DUPLICATE_PATH' }));
});

test('selected views still reject malformed unselected source details', async () => {
  const { manifest } = await fixture();
  const file = manifest.files[0];
  if (!file) throw new Error('missing file fixture');
  const broken = { ...manifest, files: [file, { ...file, path: 'src/unselected.ts', details: {} }] };
  expect(() => buildSnapshotReadView(broken, { viewId: 'one', snapshotId: broken.snapshotId, paths: [file.path] }))
    .toThrowError(expect.objectContaining({ code: 'TEXT_DETAILS_INVALID' }));
});

test('rejects cumulative declaration overflow before cloning any supplied object', async () => {
  const { manifest: original, object } = await fixture();
  const file = original.files[0]; const entry = original.objects[0];
  if (!file || !entry) throw new Error('missing fixture');
  const extra = { ...entry, path: 'objects/overflow.md', byteLength: 2 };
  const manifest = await createSnapshotManifest({ ...original,
    files: [{ ...file, objectPaths: [entry.path, extra.path] }],
    objects: [{ ...entry, byteLength: Number.MAX_SAFE_INTEGER - 1 }, extra],
  });
  const copies = vi.spyOn(readBytes, 'cloneSnapshotBytes');
  const supplied = [{ path: entry.path, bytes: new Uint8Array(object.bytes) }, { path: extra.path, bytes: new Uint8Array(2) }];
  const hugeLimits = { maxObjectBytes: Number.MAX_SAFE_INTEGER, maxFileBytes: 8192, maxTotalBytes: Number.MAX_SAFE_INTEGER };
  await expect(readSnapshotText(manifest, supplied, file.path, hugeLimits))
    .rejects.toMatchObject({ code: 'TEXT_READ_LIMIT_EXCEEDED' });
  expect(copies).not.toHaveBeenCalled();
});

test('copies all valid input bytes before asynchronous verification yields', async () => {
  const { manifest, object } = await fixture();
  const bytes = new Uint8Array(object.bytes);
  const copies = vi.spyOn(readBytes, 'cloneSnapshotBytes');
  const supplied = { path: object.path, get bytes() { queueMicrotask(() => bytes.fill(0)); return bytes; } };
  const result = await readSnapshotText(manifest, [supplied], 'src/input.ts', limits);
  expect(copies).toHaveBeenCalledTimes(1);
  expect(result.text).toBe('export const value = 1;\n');
});

test('reads actual byte storage without invoking a caller-supplied iterator', async () => {
  const { manifest, object } = await fixture();
  class CustomIterable extends Uint8Array {
    override [Symbol.iterator](): ArrayIterator<number> { throw new Error('caller iterator must not run'); }
  }
  const result = await readSnapshotText(manifest, [{ path: object.path, bytes: new CustomIterable(object.bytes) }], 'src/input.ts', limits);
  expect(result.text).toBe('export const value = 1;\n');
});

test('checks intrinsic byte length rather than a shadowing caller property', async () => {
  const { manifest, object } = await fixture();
  const bytes = new Uint8Array(9000);
  Object.defineProperty(bytes, 'byteLength', { value: object.bytes.byteLength });
  await expect(readSnapshotText(manifest, [{ path: object.path, bytes }], 'src/input.ts', limits))
    .rejects.toMatchObject({ code: 'TEXT_READ_LIMIT_EXCEEDED' });
});
