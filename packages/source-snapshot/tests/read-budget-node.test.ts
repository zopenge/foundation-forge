import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, vi } from 'vitest';
import { buildSourceTextPackage, createTextSnapshotManifest, stageSourceTextFile } from '../src/index.js';
import { publishSourceSnapshot, readPublishedSourceSnapshotText } from '../src/node.js';
import * as managed from '../src/node/managed-read.js';

const scratch = fileURLToPath(new URL('../../../.tmp/', import.meta.url));
const temporary = async () => { await mkdir(scratch, { recursive: true }); return mkdtemp(join(scratch, 'read-budget-')); };

test('bounded managed reads reject oversized stored bytes before allocating their body', async () => {
  const base = await temporary();
  try {
    await writeFile(join(base, 'object.md'), 'x'.repeat(4096));
    await expect(managed.readManagedBytes(base, 'object.md', true, { maxBytes: 1024, field: 'maxObjectBytes' }))
      .rejects.toMatchObject({ code: 'TEXT_READ_LIMIT_EXCEEDED' });
    expect((await managed.readManagedBytes(base, 'object.md', true, { maxBytes: 4096, field: 'maxObjectBytes' }))?.length).toBe(4096);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('published reader rejects declared budgets before fetching source objects', async () => {
  const base = await temporary();
  try {
    const sourceRoot = join(base, 'source'); const targetRoot = join(base, 'store');
    await mkdir(sourceRoot);
    const staged = await stageSourceTextFile({ path: 'src/a.ts', group: 'code', bytes: new TextEncoder().encode('export const a = 1;\n') });
    const textPackage = await buildSourceTextPackage([staged], { targetObjectBytes: 4096, maxObjectBytes: 8192, maxObjectCount: 10, maxObjectBytesTotal: 100000, textFormatVersion: 2 });
    const manifest = await createTextSnapshotManifest({ projectId: 'budget-fixture', policyVersion: 'v2', publishedAt: 1, repositories: [], textPackage });
    await publishSourceSnapshot({ manifest, textPackage }, { sourceRoot, targetRoot, lockPath: join(base, 'lock'), ownerId: 'budget-owner' });
    const reads = vi.spyOn(managed, 'readManagedBytes');
    try {
      await expect(readPublishedSourceSnapshotText({ targetRoot, ownerId: 'budget-owner', path: 'src/a.ts', limits: { maxObjectBytes: 1, maxFileBytes: 8192, maxTotalBytes: 8192 } }))
        .rejects.toMatchObject({ code: 'TEXT_READ_LIMIT_EXCEEDED' });
      expect(reads.mock.calls.filter(call => call[1].startsWith('objects/'))).toHaveLength(0);
    } finally { reads.mockRestore(); }
  } finally { await rm(base, { recursive: true, force: true }); }
});
