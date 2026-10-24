import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
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
  const root = await temporaryRoot('check-workers-');
  const original = process.env.VITEST_MAX_WORKERS;
  context.after(async () => {
    if (original === undefined) delete process.env.VITEST_MAX_WORKERS;
    else process.env.VITEST_MAX_WORKERS = original;
    await rm(root, { recursive: true, force: true });
  });
  const initialized = spawnSync('git', ['init', '--quiet', root], { encoding: 'utf8', windowsHide: true });
  assert.equal(initialized.status, 0, initialized.stderr);
  await writeFile(join(root, '.gitignore'), 'node_modules/\n');
  await writeFile(join(root, 'input.txt'), 'unchanged input\n');
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, 'node_modules/.modules.yaml'), 'storeDir: fixture\n');
  process.env.VITEST_MAX_WORKERS = '1';
  const before = await collectWorkspaceFingerprint(root);
  process.env.VITEST_MAX_WORKERS = '2';
  const after = await collectWorkspaceFingerprint(root);
  assert.deepEqual(before.files, after.files);
  assert.deepEqual(selectCheckMode(before, after, []), { kind: 'full' });
});
