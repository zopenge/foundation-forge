import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { collectTarballDigests } from '../check-fingerprint.mjs';

test('cached tarballs bind package identity to bytes and reject escaped paths', async (context) => {
  const root = await mkdtemp(resolve('.tmp', 'check-tarballs-'));
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
