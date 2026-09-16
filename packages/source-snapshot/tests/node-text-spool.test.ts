import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { calculateBytesIntegrity } from '@openge/forge-artifact-integrity';
import { createSnapshotManifest, readSnapshotText, stageSourceTextFile } from '../src/index.js';
import { createSourceTextSpoolBuilder } from '../src/node/text-spool.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

test('spools packed text objects while retaining only manifest metadata', async () => {
  const spoolRoot = await mkdtemp(join(tmpdir(), 'source-text-spool-')); roots.push(spoolRoot);
  const builder = await createSourceTextSpoolBuilder({
    spoolRoot,
    pack: { targetObjectBytes: 4096, maxObjectBytes: 8192, maxObjectCount: 100, maxObjectBytesTotal: 1_000_000, textFormatVersion: 2 },
  });
  const same = await stageSourceTextFile({ path: 'src/a.ts', group: 'code', bytes: utf8('same\n') });
  const alias = await stageSourceTextFile({ path: 'src/b.ts', group: 'code', bytes: utf8('same\n') });
  const large = await stageSourceTextFile({ path: 'src/large.ts', group: 'code', bytes: utf8(`+${'🙂'.repeat(3000)}`) });
  await builder.add(same); await builder.add(alias); await builder.add(large);
  const prepared = await builder.finish();

  expect(prepared.files).toHaveLength(3);
  expect(prepared.objects.length).toBeGreaterThan(1);
  expect(prepared.files[0]?.objectPaths).toEqual(prepared.files[1]?.objectPaths);
  expect(prepared.metrics.logicalSourceBytes).toBe(same.byteLength + alias.byteLength + large.byteLength);
  expect(prepared.metrics.uniqueNormalizedBodyBytes).toBe(same.normalizedByteLength + large.normalizedByteLength);
  const manifest = await createSnapshotManifest({
    projectId: 'spool-fixture', policyVersion: '1', publishedAt: 1,
    repositories: [], files: prepared.files, objects: prepared.objects.map(({ path, sha256, byteLength }) => ({ path, sha256, byteLength })),
  });
  const objectBytes: Array<{ path: string; bytes: Uint8Array }> = [];
  for (const object of prepared.objects) {
    expect(existsSync(object.spoolPath)).toBe(true);
    const bytes = await readFile(object.spoolPath);
    const integrity = await calculateBytesIntegrity(bytes);
    expect(integrity).toMatchObject({ sha256: object.sha256, byteLength: object.byteLength });
    objectBytes.push({ path: object.path, bytes });
  }
  const read = async (path: string) => {
    const file = manifest.files.find(candidate => candidate.path === path);
    if (file === undefined) throw new Error(`missing manifest file ${path}`);
    const required = new Set(file.objectPaths);
    return readSnapshotText(manifest, objectBytes.filter(object => required.has(object.path)), path, {
      maxObjectBytes: 8192, maxFileBytes: 100_000, maxTotalBytes: 1_000_000,
    });
  };
  expect((await read(same.path)).text).toBe('same\n');
  expect((await read(alias.path)).text).toBe('same\n');
  expect((await read(large.path)).text).toBe(large.text);

  await builder.dispose();
  expect(existsSync(spoolRoot)).toBe(false);
});
