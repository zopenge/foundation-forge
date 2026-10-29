import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import test from 'node:test';

import { collectTarballDigests, collectWorkspaceFingerprint } from '../check-fingerprint.mjs';
import { selectCheckMode } from '../check-mode.mjs';

const temporaryRoot = async (prefix) => {
  const base = resolve(import.meta.dirname, '../../.tmp');
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, prefix));
};

test('cached tarballs bind package identity to bytes and reject escaped paths', async (context) => {
  const root = await temporaryRoot('check-tarballs-');
  context.after(() => rm(root, { recursive: true, force: true }));
  const filename = 'example-package-1.0.0.tgz';
  await writeFile(join(root, filename), 'first tarball bytes');
  await writeFile(join(root, 'tarballs.json'), JSON.stringify({ '@example/package': filename }));
  const packages = [{ name: '@example/package' }];
  const before = await collectTarballDigests(packages, root);
  await writeFile(join(root, filename), 'changed tarball bytes');
  const after = await collectTarballDigests(packages, root);
  assert.notEqual(before['@example/package'].sha256, after['@example/package'].sha256);

  await writeFile(join(root, 'tarballs.json'), JSON.stringify({ '@example/package': '../outside.tgz' }));
  await assert.rejects(collectTarballDigests(packages, root), /invalid cached tarball path/u);
  await writeFile(join(root, 'tarballs.json'), '{}');
  await assert.rejects(collectTarballDigests(packages, root), /does not cover/u);
});

test('changing the effective worker cap invalidates a cached workspace check', async (context) => {
  for (const variable of ['VITEST_MAX_WORKERS', 'FORGE_CHECK_TEST_WORKERS', 'FORGE_CHECK_WORKER_CEILING']) {
  const root = await temporaryRoot('check-workers-');
  const original = process.env[variable];
  context.after(async () => {
    if (original === undefined) Reflect.deleteProperty(process.env, variable);
    else process.env[variable] = original;
    await rm(root, { recursive: true, force: true });
  });
  const initialized = spawnSync('git', ['init', '--quiet', root], { encoding: 'utf8', windowsHide: true });
  assert.equal(initialized.status, 0, initialized.stderr);
  await writeFile(join(root, '.gitignore'), 'node_modules/\n');
  await writeFile(join(root, 'input.txt'), 'unchanged input\n');
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, 'node_modules/.modules.yaml'), 'storeDir: fixture\n');
  process.env[variable] = '1';
  const before = await collectWorkspaceFingerprint(root);
  process.env[variable] = '2';
  const after = await collectWorkspaceFingerprint(root);
  assert.deepEqual(before.files, after.files);
  assert.deepEqual(selectCheckMode(before, after, []), { kind: 'full' });
  }
});

test('嵌套 pnpm 重复 PATH 项保持收据有效，改变查找顺序仍使收据失效', async context => {
  const root = await temporaryRoot('check-path-'), original = process.env.PATH;
  context.after(async () => {
    process.env.PATH = original;
    await rm(root, { recursive: true, force: true });
  });
  assert.equal(spawnSync('git', ['init', '--quiet', root], { windowsHide: true }).status, 0);
  await writeFile(join(root, '.gitignore'), 'node_modules/\n');
  await writeFile(join(root, 'input.txt'), 'input\n');
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, 'node_modules/.modules.yaml'), 'storeDir: fixture\n');
  const first = resolve(root, 'one'), second = resolve(root, 'two');
  process.env.PATH = [first, second, original].join(delimiter);
  const before = await collectWorkspaceFingerprint(root);
  process.env.PATH = [first, second, first, second, original].join(delimiter);
  assert.deepEqual(await collectWorkspaceFingerprint(root), before);
  process.env.PATH = [second, first, original].join(delimiter);
  assert.notEqual((await collectWorkspaceFingerprint(root)).environmentDigest, before.environmentDigest);
});
