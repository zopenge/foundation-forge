import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import {
  inspectSourceSnapshotPins,
  inspectSourceSnapshotStoreUsage,
  upsertSourceSnapshotPin,
} from '@openge/forge-source-snapshot/node';

const binaries = JSON.parse(process.env.PACKAGE_CONSUMER_BINARIES ?? '{}');
const bin = binaries['forge-source-snapshot'];
assert.equal(typeof bin, 'string');
const base = await mkdtemp(join(tmpdir(), 'source-snapshot-neutral-consumer-'));
const source = join(base, 'source'); const target = join(base, 'target'); const state = join(base, 'state');
await Promise.all([mkdir(source), mkdir(target), mkdir(state)]);
try {
  execFileSync('git', ['init', '--quiet'], { cwd: source });
  execFileSync('git', ['config', 'user.email', 'neutral@example.invalid'], { cwd: source });
  execFileSync('git', ['config', 'user.name', 'Neutral Consumer'], { cwd: source });
  await writeFile(join(source, '.gitignore'), 'ignored/\n', 'utf8');
  await mkdir(join(source, 'src'));
  await writeFile(join(source, 'src', 'value.ts'), 'export const value = 2\r\n', 'utf8');
  execFileSync('git', ['add', '.gitignore', 'src/value.ts'], { cwd: source });
  execFileSync('git', ['commit', '--quiet', '-m', 'baseline'], { cwd: source });
  const lockPath = join(state, 'snapshot.lock');
  const config = join(base, 'source-snapshot.config.mjs');
  await writeFile(config, `export default ${JSON.stringify({
    projectId: 'neutral-node-consumer', policyVersion: '2', sourceRoot: source, targetRoot: target,
    lockPath, ownerId: 'neutral-owner', policy: { textExtensions: ['.ts'], textBasenames: ['.gitignore'] },
    pack: { targetObjectBytes: 4096, maxObjectBytes: 8192, maxObjectCount: 20, maxObjectBytesTotal: 100000, textFormatVersion: 2 },
  })};\nexport const groupForPath = path => path.endsWith('.ts') ? 'code' : 'root';\n`, 'utf8');
  const exported = spawnSync(process.execPath, [bin, 'export', '--config', config, '--json'], {
    cwd: base, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(exported.status, 0, exported.stdout + exported.stderr);
  const snapshotId = JSON.parse(exported.stdout).snapshotId;
  assert.match(snapshotId, /^snapshot-[a-f0-9]{64}$/u);

  await rm(source, { recursive: true, force: true });
  await rm(config, { force: true });
  const read = spawnSync(process.execPath, [bin, 'read', '--target-root', target, '--owner-id', 'neutral-owner',
    '--snapshot-id', snapshotId, '--path', 'src/value.ts', '--json'], {
    cwd: base, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(read.status, 0, read.stdout + read.stderr);
  assert.equal(JSON.parse(read.stdout).text, 'export const value = 2\n');
  const unpackRoot = join(base, 'unpacked');
  const unpacked = spawnSync(process.execPath, [bin, 'unpack', '--target-root', target, '--owner-id', 'neutral-owner',
    '--snapshot-id', snapshotId, '--output', unpackRoot, '--json'], {
    cwd: base, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(unpacked.status, 0, unpacked.stdout + unpacked.stderr);
  assert.equal(JSON.parse(unpacked.stdout).writtenFileCount, 2);
  assert.equal(await readFile(join(unpackRoot, 'src', 'value.ts'), 'utf8'), 'export const value = 2\n');

  const pins = await inspectSourceSnapshotPins({ targetRoot: target, ownerId: 'neutral-owner' });
  assert.match(pins.revision, /^[a-f0-9]{64}$/u); assert.deepEqual(pins.pins, []);
  const pinned = await upsertSourceSnapshotPin({
    targetRoot: target, ownerId: 'neutral-owner', lockPath, expectedRevision: pins.revision,
    pin: { pinId: 'neutral-proof', snapshotId, reasonCode: 'tarball-proof', createdAt: 2 },
  });
  assert.match(pinned.revision, /^[a-f0-9]{64}$/u); assert.notEqual(pinned.revision, pins.revision);
  assert.equal(pinned.pins[0]?.snapshotId, snapshotId);
  const usage = await inspectSourceSnapshotStoreUsage({
    targetRoot: target, ownerId: 'neutral-owner', now: 2, keepCount: 1,
  });
  assert.ok(usage.managedBytes > 0); assert.ok(usage.objectBytes > 0);
} finally {
  await rm(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
