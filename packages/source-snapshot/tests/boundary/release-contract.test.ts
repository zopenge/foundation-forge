import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test } from 'vitest';
import { runSourceSnapshotCli } from '../../src/node.js';
import { addCommittedFile, createRepository } from '../node-fixtures.js';

const roots: string[] = [];
const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'snapshot-release-contract-'));
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

test('CLI export preserves textFormatVersion=2 so published-only read survives source/config removal', async () => {
  const base = await makeRoot();
  const source = await createRepository();
  roots.push(source);
  const target = join(base, 'target'); const state = join(base, 'state');
  await mkdir(target); await mkdir(state);
  await addCommittedFile(source, 'src/value.ts', 'export const value = 2\r\n');
  const config = join(base, 'source-snapshot.config.mjs');
  await writeFile(config, `export default ${JSON.stringify({
    projectId: 'release-contract', policyVersion: '2', sourceRoot: source, targetRoot: target,
    lockPath: join(state, 'snapshot.lock'), ownerId: 'release-owner',
    policy: { textExtensions: ['.ts'], textBasenames: ['.gitignore'] },
    pack: { targetObjectBytes: 4096, maxObjectBytes: 8192, maxObjectCount: 20, maxObjectBytesTotal: 100000, textFormatVersion: 2 },
  })};\nexport const groupForPath = () => 'code';\n`, 'utf8');
  const output: string[] = [];
  const exported = await runSourceSnapshotCli(['export', '--config', config, '--json'], {
    cwd: base, now: () => 1, stdout: value => output.push(value), stderr: value => { throw new Error(value); },
  });
  expect(exported.exitCode).toBe(0);
  const snapshotId = JSON.parse(output.join('')).snapshotId as string;
  await rm(source, { recursive: true, force: true });
  await rm(config, { force: true });

  const readOutput: string[] = [];
  const read = await runSourceSnapshotCli([
    'read', '--target-root', target, '--owner-id', 'release-owner', '--snapshot-id', snapshotId,
    '--path', 'src/value.ts', '--json',
  ], { cwd: base, stdout: value => readOutput.push(value), stderr: value => { throw new Error(value); } });
  expect(read.exitCode).toBe(0);
  expect(JSON.parse(readOutput.join(''))).toMatchObject({
    status: 'READ', path: 'src/value.ts', text: 'export const value = 2\n', assurance: 'normalized-text-verified',
  });
  const unpackRoot = join(base, 'unpacked');
  const unpackOutput: string[] = [];
  const unpack = await runSourceSnapshotCli([
    'unpack', '--target-root', target, '--owner-id', 'release-owner', '--snapshot-id', snapshotId,
    '--output', unpackRoot, '--json',
  ], { cwd: base, stdout: value => unpackOutput.push(value), stderr: value => { throw new Error(value); } });
  expect(unpack.exitCode).toBe(0);
  expect(JSON.parse(unpackOutput.join(''))).toMatchObject({ status: 'UNPACKED', snapshotId, writtenFileCount: 2 });
  expect(await readFile(join(unpackRoot, 'src', 'value.ts'), 'utf8')).toBe('export const value = 2\n');
  expect(await readFile(join(unpackRoot, '.gitignore'), 'utf8')).toBe('ignored/\n');
});
