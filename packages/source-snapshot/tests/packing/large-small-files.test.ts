import { expect, test } from 'vitest';
import { buildSourceTextPackage, createTextSnapshotManifest, reconstructSourceText, stageSourceTextFile } from '../../src/index.js';
import type { StagedSourceTextFile } from '../../src/content-contracts.js';

const sha = (value: number): string => value.toString(16).padStart(64, '0').slice(-64);
const makeFile = (index: number): StagedSourceTextFile => Object.freeze({
  path: `src/file-${String(index).padStart(6, '0')}.ts`,
  group: 'one-group', sha256: sha(index + 1), byteLength: 2, text: 'x\n',
  encoding: 'utf8', bom: null, lineCount: 1,
  normalizedSha256: sha(index + 100_000), normalizedByteLength: 2, finalNewline: true,
});

test('packs one thousand small files without quadratic packing growth', async () => {
  const files = Array.from({ length: 1_000 }, (_, index) => makeFile(index));
  const packed = await buildSourceTextPackage(files, {
    targetObjectBytes: 131_072, maxObjectBytes: 262_144,
    maxObjectCount: 100, maxObjectBytesTotal: 16 * 1024 * 1024, textFormatVersion: 2,
  });
  expect(packed.files).toHaveLength(files.length);
  const first = files[0]; const last = files.at(-1);
  if (first === undefined || last === undefined) throw new Error('missing fixture files');
  expect(reconstructSourceText(packed, first.path)).toBe('x\n');
  expect(reconstructSourceText(packed, last.path)).toBe('x\n');
}, 5_000);


test('creates a manifest for twenty thousand aliases without per-file full scans', async () => {
  const base = await stageSourceTextFile({
    path: 'src/base.ts', group: 'one-group', bytes: new TextEncoder().encode('x\n'),
  });
  const files = Array.from({ length: 20_000 }, (_, index) => Object.freeze({
    ...base, path: `src/alias-${String(index).padStart(6, '0')}.ts`,
  }));
  const packed = await buildSourceTextPackage(files, {
    targetObjectBytes: 131_072, maxObjectBytes: 262_144,
    maxObjectCount: 100, maxObjectBytesTotal: 16 * 1024 * 1024, textFormatVersion: 2,
  });
  const manifest = await createTextSnapshotManifest({
    projectId: 'large-small-files', policyVersion: '1', publishedAt: 1,
    repositories: [], textPackage: packed,
  });
  expect(manifest.files).toHaveLength(files.length);
}, 5_000);
