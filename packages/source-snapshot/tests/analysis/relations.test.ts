import { expect, test } from 'vitest';
import {
  buildSnapshotReadProfileView,
  buildSourceTextPackage,
  createSnapshotManifest,
  createTextSnapshotManifest,
  stageSourceTextFile,
  validateSnapshotRelations,
} from '../../src/index.js';
import type { SnapshotManifest } from '../../src/index.js';

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
const required = <T>(value: T | undefined, label: string): T => {
  if (value === undefined) throw new Error(`missing ${label}`);
  return value;
};
const pack = (textFormatVersion: 1 | 2) => ({
  targetObjectBytes: 4096, maxObjectBytes: 8192, maxObjectCount: 20,
  maxObjectBytesTotal: 100_000, textFormatVersion,
});
async function mixedManifest(): Promise<SnapshotManifest> {
  const main = await stageSourceTextFile({ path: 'src/main.ts', group: 'code', bytes: utf8('import "./util"\n') });
  const util = await stageSourceTextFile({ path: 'src/util.ts', group: 'code', bytes: utf8('export const util = 1\n') });
  const ref = await stageSourceTextFile({ path: 'docs/ref.md', group: 'docs', bytes: utf8('# Ref\n') });
  const v2 = await buildSourceTextPackage([main, util], pack(2));
  const v1 = await buildSourceTextPackage([ref], pack(1));
  const [m2, m1] = await Promise.all([
    createTextSnapshotManifest({ projectId: 'analysis-fixture', policyVersion: '2', publishedAt: 1, repositories: [], textPackage: v2 }),
    createTextSnapshotManifest({ projectId: 'analysis-fixture', policyVersion: '2', publishedAt: 1, repositories: [], textPackage: v1 }),
  ]);
  return createSnapshotManifest({
    projectId: 'analysis-fixture', policyVersion: '2', publishedAt: 1, repositories: [],
    objects: [...m2.objects, ...m1.objects], files: [...m2.files, ...m1.files],
  });
}
test('read profile reports duplicates, missing and legacy unsupported deterministically', async () => {
  const manifest = await mixedManifest();
  const view = buildSnapshotReadProfileView(manifest, {
    profileId: 'review', snapshotId: manifest.snapshotId,
    preferredPaths: ['src/main.ts', 'missing.ts', 'src/main.ts'],
    referencePaths: ['docs/ref.md'],
  });
  expect(view.duplicatePaths).toEqual(['src/main.ts']);
  expect(view.preferred).toMatchObject({ found: ['src/main.ts'], missing: ['missing.ts'], unsupported: [] });
  expect(view.reference).toMatchObject({ found: [], missing: [], unsupported: ['docs/ref.md'] });
  expect(view.preferred.files.map(file => file.path)).toEqual(['src/main.ts']);
});

test('read profile rejects cross-snapshot and unsafe paths without interpreting path meaning', async () => {
  const manifest = await mixedManifest();
  expect(() => buildSnapshotReadProfileView(manifest, {
    profileId: 'wrong', snapshotId: `snapshot-${'f'.repeat(64)}`,
    preferredPaths: ['src/main.ts'], referencePaths: [],
  })).toThrowError(expect.objectContaining({ code: 'ANALYSIS_SOURCE_MISMATCH' }));
  expect(() => buildSnapshotReadProfileView(manifest, {
    profileId: 'unsafe', snapshotId: manifest.snapshotId,
    preferredPaths: ['../outside.ts'], referencePaths: [],
  })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
});
test('validates declared resolved relations against snapshot endpoints and source hash', async () => {
  const manifest = await mixedManifest();
  const main = required(manifest.files.find(file => file.path === 'src/main.ts'), 'main file');
  const result = validateSnapshotRelations(manifest, [{
    relationId: 'r1', snapshotId: manifest.snapshotId, kind: 'imports',
    fromPath: 'src/main.ts', toPath: 'src/util.ts', sourceSha256: main.sha256,
    resolution: 'resolved', diagnostics: ['static-parser'],
  }]);
  expect(result).toMatchObject({ schemaVersion: 1, snapshotId: manifest.snapshotId, relationCount: 1 });
  expect(result.relations[0]).toMatchObject({ relationId: 'r1', kind: 'imports', resolution: 'resolved' });
});

test('source mismatch, missing resolved endpoints and duplicate relation ids fail closed', async () => {
  const manifest = await mixedManifest();
  const main = required(manifest.files.find(file => file.path === 'src/main.ts'), 'main file');
  const base = { relationId: 'r1', snapshotId: manifest.snapshotId, kind: 'references' as const,
    fromPath: 'src/main.ts', toPath: 'src/util.ts', sourceSha256: main.sha256, resolution: 'resolved' as const };
  expect(() => validateSnapshotRelations(manifest, [{ ...base, sourceSha256: '0'.repeat(64) }]))
    .toThrowError(expect.objectContaining({ code: 'ANALYSIS_SOURCE_MISMATCH' }));
  expect(() => validateSnapshotRelations(manifest, [{ ...base, toPath: 'src/missing.ts' }]))
    .toThrowError(expect.objectContaining({ code: 'ANALYSIS_SOURCE_MISMATCH' }));
  expect(() => validateSnapshotRelations(manifest, [base, { ...base }]))
    .toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
});
test('unresolved and external relations are preserved as declarations without fetching targets', async () => {
  const manifest = await mixedManifest();
  const main = required(manifest.files.find(file => file.path === 'src/main.ts'), 'main file');
  const result = validateSnapshotRelations(manifest, [
    { relationId: 'dynamic', snapshotId: manifest.snapshotId, kind: 'imports', fromPath: 'src/main.ts',
      toPath: 'dynamic:runtime-value', sourceSha256: main.sha256, resolution: 'unresolved', diagnostics: ['dynamic-specifier'] },
    { relationId: 'external', snapshotId: manifest.snapshotId, kind: 'references', fromPath: 'src/main.ts',
      toPath: 'https://example.invalid/do-not-fetch', sourceSha256: main.sha256, resolution: 'external' },
  ]);
  expect(result.relations.map(value => [value.relationId, value.resolution, value.toPath])).toEqual([
    ['dynamic', 'unresolved', 'dynamic:runtime-value'],
    ['external', 'external', 'https://example.invalid/do-not-fetch'],
  ]);
});

test('absence of declared relations remains an empty relation set and never becomes dead-code metadata', async () => {
  const manifest = await mixedManifest();
  const result = validateSnapshotRelations(manifest, []);
  expect(result).toEqual({ schemaVersion: 1, snapshotId: manifest.snapshotId, relationCount: 0, relations: [] });
  expect(JSON.stringify(result)).not.toMatch(/unused|dead/iu);
});
test('relation snapshot binding and bounded diagnostics fail closed', async () => {
  const manifest = await mixedManifest();
  const main = required(manifest.files.find(file => file.path === 'src/main.ts'), 'main file');
  const relation = { relationId: 'bound', snapshotId: manifest.snapshotId, kind: 'exports' as const,
    fromPath: 'src/main.ts', toPath: 'src/util.ts', sourceSha256: main.sha256, resolution: 'resolved' as const };
  expect(() => validateSnapshotRelations(manifest, [{ ...relation, snapshotId: `snapshot-${'e'.repeat(64)}` }]))
    .toThrowError(expect.objectContaining({ code: 'ANALYSIS_SOURCE_MISMATCH' }));
  expect(() => validateSnapshotRelations(manifest, [{ ...relation, diagnostics: Array.from({ length: 33 }, (_, index) => `d${index}`) }]))
    .toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
});
