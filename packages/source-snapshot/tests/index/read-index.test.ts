import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  buildSnapshotReadIndex,
  buildSnapshotReadView,
  buildSourceTextPackage,
  createTextSnapshotManifest,
  stageSourceTextFile,
} from '../../src/index.js';
import { publishSourceSnapshot } from '../../src/node.js';

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
const pack = {
  targetObjectBytes: 2048,
  maxObjectBytes: 4096,
  maxObjectCount: 100,
  maxObjectBytesTotal: 1_000_000,
  textFormatVersion: 2 as const,
};

async function fixture(files: readonly { path: string; group: string; text: string }[]) {
  const staged = await Promise.all(files.map(file => stageSourceTextFile({ ...file, bytes: utf8(file.text) })));
  const textPackage = await buildSourceTextPackage(staged, pack);
  const manifest = await createTextSnapshotManifest({
    projectId: 'read-index-fixture', policyVersion: 'v2', publishedAt: 1,
    repositories: [], textPackage,
  });
  return { manifest, textPackage };
}
test('builds exact v2 read entries with object requirements and byte locators', async () => {
  const { manifest } = await fixture([
    { path: 'src/中文.ts', group: 'code', text: `第一行\n${'🙂'.repeat(1500)}` },
    { path: 'src/empty.ts', group: 'code', text: '' },
  ]);
  const index = buildSnapshotReadIndex(manifest);
  expect(index).toMatchObject({ schemaVersion: 1, snapshotId: manifest.snapshotId, fileCount: 2 });
  expect(index.files.map(file => file.path)).toEqual(['src/empty.ts', 'src/中文.ts']);
  expect(index.metrics.sourceLines).toBe(index.files.reduce((sum, file) => sum + file.sourceLineCount, 0));
  const uniqueObjects = new Map(index.files.flatMap(file => file.objectRequirements).map(object => [object.path, object]));
  expect(index.metrics.objectBytes).toBe([...uniqueObjects.values()].reduce((sum, object) => sum + object.byteLength, 0));
  expect(index.metrics.renderingLines).toBeGreaterThan(0);

  const large = index.files.find(file => file.path === 'src/中文.ts');
  expect(large).toBeDefined();
  expect(large?.assurance).toBe('normalized-text-verified');
  expect(large?.formatVersion).toBe(2);
  expect(large?.objectRequirements.length).toBeGreaterThan(1);
  expect(large?.locators.length).toBeGreaterThan(1);
  expect(large?.locators.map(locator => locator.sourceByteOffset)).toEqual(
    large?.locators.map((_, i, values) => values.slice(0, i).reduce((sum, item) => sum + item.bodyByteLength, 0)),
  );

  const empty = index.files.find(file => file.path === 'src/empty.ts');
  expect(empty?.normalizedByteLength).toBe(0);
  expect(empty?.locators).toHaveLength(1);
});
test('reports exact path view results without expanding missing or legacy paths', async () => {
  const staged = await stageSourceTextFile({ path: 'src/legacy.ts', group: 'code', bytes: utf8('legacy\n') });
  const textPackage = await buildSourceTextPackage([staged], {
    targetObjectBytes: 4096, maxObjectBytes: 8192, maxObjectCount: 10, maxObjectBytesTotal: 100_000,
  });
  const manifest = await createTextSnapshotManifest({
    projectId: 'legacy-index', policyVersion: 'v1', publishedAt: 1, repositories: [], textPackage,
  });
  const index = buildSnapshotReadIndex(manifest);
  expect(index.files[0]).toMatchObject({ path: 'src/legacy.ts', formatVersion: 1, assurance: 'object-integrity' });
  expect(index.files[0]?.locators).toEqual([]);

  const view = buildSnapshotReadView(manifest, {
    viewId: 'exact-only', snapshotId: manifest.snapshotId,
    paths: ['src/legacy.ts', 'src/missing.ts'],
  });
  expect(view.found).toEqual([]);
  expect(view.unsupported).toEqual(['src/legacy.ts']);
  expect(view.missing).toEqual(['src/missing.ts']);
});
test('publishes machine and human indexes from the same derived read index', async () => {
  const { manifest, textPackage } = await fixture([
    { path: 'src/main.ts', group: 'code', text: 'export const value = 1\n' },
    { path: 'docs/readme.md', group: 'docs', text: '# 文档\n' },
  ]);
  const base = await mkdtemp(join(tmpdir(), 'forge-read-index-'));
  const targetRoot = join(base, 'store');
  try {
    await publishSourceSnapshot({ manifest, textPackage }, {
      sourceRoot: join(base, 'source'), targetRoot,
      lockPath: join(base, 'publish.lock'), ownerId: 'read-index-owner',
    });
    const expected = buildSnapshotReadIndex(manifest);
    const snapshotRoot = join(targetRoot, 'snapshots', manifest.snapshotId);
    const machine = JSON.parse(await readFile(join(snapshotRoot, 'READ-INDEX.json'), 'utf8'));
    expect(machine).toEqual(expected);

    const human = await readFile(join(snapshotRoot, 'INDEX.md'), 'utf8');
    expect(expected.metrics.renderingLines).toBe(human.split('\n').length - 1);
    for (const file of expected.files) {
      expect(human).toContain(`\`${file.path}\``);
      for (const object of file.objectRequirements) expect(human).toContain(`\`${object.path}\``);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
test('index object requirements feed the authenticated reader without directory discovery', async () => {
  const { manifest, textPackage } = await fixture([
    { path: 'src/verify.ts', group: 'code', text: '第一行\r\n第二行🙂' },
  ]);
  const index = buildSnapshotReadIndex(manifest);
  const file = index.files[0];
  if (file === undefined) throw new Error('missing index file fixture');
  const objectBytes = new Map(textPackage.objects.map(object => [object.path, utf8(object.content)]));
  const objects = file.objectRequirements.map(requirement => {
    const bytes = objectBytes.get(requirement.path);
    if (bytes === undefined) throw new Error('missing object fixture');
    return { path: requirement.path, bytes };
  });
  const { readSnapshotText } = await import('../../src/index.js');
  const result = await readSnapshotText(manifest, objects, file.path, {
    maxObjectBytes: 1_048_576,
    maxFileBytes: 16_777_216,
    maxTotalBytes: 67_108_864,
  });
  expect(result.normalizedSha256).toBe(file.normalizedSha256);
  expect(result.text).toBe('第一行\n第二行🙂');
});