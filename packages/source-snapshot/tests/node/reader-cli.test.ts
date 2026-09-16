import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  exportRepositorySnapshot,
  readPublishedSourceSnapshotText,
  runSourceSnapshotCli,
  unpackPublishedSourceSnapshot,
} from '../../src/node.js';
import { addCommittedFile, createRepository, removeRepository } from '../node-fixtures.js';

const limits = { maxObjectBytes: 1_048_576, maxFileBytes: 16_777_216, maxTotalBytes: 67_108_864 };

async function publishedFixture() {
  const source = await createRepository();
  await addCommittedFile(source, 'src/main.ts', 'alpha\r\nbeta🙂');
  const base = await mkdtemp(join(tmpdir(), 'forge-source-reader-'));
  const target = join(base, 'store');
  const state = join(base, 'state');
  await mkdir(state);
  const options = {
    sourceRoot: source,
    projectId: 'published-reader',
    policyVersion: '2',
    publishedAt: 1,
    policy: { textExtensions: ['.ts'], textBasenames: ['.gitignore'] },
    pack: { targetObjectBytes: 4096, maxObjectBytes: 8192, maxObjectCount: 20, maxObjectBytesTotal: 100_000, textFormatVersion: 2 as const },
    groupForPath: (path: string) => path.endsWith('.ts') ? 'code' : 'root',
    targetRoot: target,
    lockPath: join(state, 'publish.lock'),
    ownerId: 'reader-owner',
  };  const result = await exportRepositorySnapshot(options);
  if (result.status === 'BLOCKED') throw new Error('fixture export blocked');
  await removeRepository(source);
  return {
    base,
    target,
    ownerId: options.ownerId,
    snapshotId: result.publication.snapshotId,
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

test('reads a published v2 file after the original source repository is gone', async () => {
  const fixture = await publishedFixture();
  try {
    const result = await readPublishedSourceSnapshotText({
      targetRoot: fixture.target,
      ownerId: fixture.ownerId,
      snapshotId: fixture.snapshotId,
      path: 'src/main.ts',
      limits,
    });
    expect(result.text).toBe('alpha\nbeta🙂');
    expect(result.assurance).toBe('normalized-text-verified');
  } finally {
    await fixture.cleanup();
  }
});

test('read CLI needs only explicit store identity and does not load a project config', async () => {
  const fixture = await publishedFixture();
  try {
    await writeFile(join(fixture.base, 'source-snapshot.config.mjs'), "throw new Error('reader must not load config');\n", 'utf8');
    const stdout: string[] = [];
    const stderr: string[] = [];
    const outcome = await runSourceSnapshotCli([      'read', '--target-root', fixture.target, '--owner-id', fixture.ownerId,
      '--snapshot-id', fixture.snapshotId, '--path', 'src/main.ts', '--json',
    ], { cwd: fixture.base, stdout: value => stdout.push(value), stderr: value => stderr.push(value) });
    expect(outcome.exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      status: 'READ',
      path: 'src/main.ts',
      text: 'alpha\nbeta🙂',
      assurance: 'normalized-text-verified',
    });
  } finally {
    await fixture.cleanup();
  }
});

test('unpack writes normalized UTF-8 only into an explicit empty directory', async () => {
  const fixture = await publishedFixture();
  const output = join(fixture.base, 'unpacked');
  try {
    const result = await unpackPublishedSourceSnapshot({
      targetRoot: fixture.target,
      ownerId: fixture.ownerId,
      snapshotId: fixture.snapshotId,
      outputRoot: output,
      limits,
    });
    expect(result).toMatchObject({ status: 'UNPACKED', writtenFileCount: 2 });
    expect(await readFile(join(output, 'src', 'main.ts'), 'utf8')).toBe('alpha\nbeta🙂');
    await writeFile(join(output, 'manual.txt'), 'keep', 'utf8');
    await expect(unpackPublishedSourceSnapshot({
      targetRoot: fixture.target, ownerId: fixture.ownerId,
      snapshotId: fixture.snapshotId, outputRoot: output, limits,
    })).rejects.toMatchObject({ code: 'OUTPUT_NOT_EMPTY' });
  } finally {
    await fixture.cleanup();
  }
});

test('unpack CLI writes to an explicit output root without a project config', async () => {
  const fixture = await publishedFixture();
  const output = join(fixture.base, 'cli-unpacked');
  try {
    const stdout: string[] = [];
    const outcome = await runSourceSnapshotCli([
      'unpack', '--target-root', fixture.target, '--owner-id', fixture.ownerId,
      '--snapshot-id', fixture.snapshotId, '--output', output, '--json',
    ], { stdout: value => stdout.push(value), stderr: value => { throw new Error(value); } });
    expect(outcome.exitCode).toBe(0);
    expect(JSON.parse(stdout.join(''))).toMatchObject({ status: 'UNPACKED', writtenFileCount: 2 });
    expect(await readFile(join(output, 'src', 'main.ts'), 'utf8')).toBe('alpha\nbeta🙂');
  } finally {
    await fixture.cleanup();
  }
});

test('missing published object reports OBJECT_MISSING instead of snapshot absence', async () => {
  const fixture = await publishedFixture();
  try {
    const names = await readdir(join(fixture.target, 'objects'));
    const first = names[0];
    if (first === undefined) throw new Error('missing object fixture');
    await rm(join(fixture.target, 'objects', first), { force: true });
    await expect(readPublishedSourceSnapshotText({
      targetRoot: fixture.target,
      ownerId: fixture.ownerId,
      snapshotId: fixture.snapshotId,
      path: 'src/main.ts',
      limits,
    })).rejects.toMatchObject({ code: 'OBJECT_MISSING' });
  } finally {
    await fixture.cleanup();
  }
});
