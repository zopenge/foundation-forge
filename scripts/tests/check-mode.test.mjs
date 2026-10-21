import assert from 'node:assert/strict';
import test from 'node:test';

import { selectCheckMode } from '../check-mode.mjs';

const packages = [
  { name: '@example/core', directory: 'packages/core', workspaceDependencies: [] },
  { name: '@example/leaf', directory: 'packages/leaf', workspaceDependencies: ['@example/core'] },
  { name: '@example/other', directory: 'packages/other', workspaceDependencies: [] },
];
const baseline = {
  schemaVersion: 1,
  environmentDigest: 'env',
  files: {
    'package.json': 'root',
    'packages/core/src/index.ts': 'core',
    'packages/leaf/src/index.ts': 'leaf',
    'packages/other/src/index.ts': 'other',
  },
};
const current = (files, environmentDigest = 'env') => ({
  schemaVersion: 1, environmentDigest, files: { ...baseline.files, ...files },
});

test('reuses an exact successful workspace fingerprint', () => {
  assert.deepEqual(selectCheckMode(baseline, current({}), packages), { kind: 'cached' });
});

test('selects only a changed leaf package source or test', () => {
  assert.deepEqual(selectCheckMode(baseline, current({
    'packages/leaf/src/index.ts': 'changed',
    'packages/leaf/tests/new.test.ts': 'new',
  }), packages), { kind: 'leaf', packageName: '@example/leaf' });
});

test('keeps a leaf check when documentation and its packaged README change with source', () => {
  assert.deepEqual(selectCheckMode(baseline, current({
    'packages/leaf/src/index.ts': 'changed',
    'packages/leaf/README.md': 'changed',
    'docs/packages/leaf.md': 'changed',
    '.changeset/leaf-update.md': 'new',
  }), packages), { kind: 'leaf', packageName: '@example/leaf' });
});

test('uses a documentation check when only prose or Changesets change', () => {
  assert.deepEqual(selectCheckMode(baseline, current({
    'README.md': 'changed',
    'docs/packages/leaf.md': 'changed',
    '.changeset/leaf-update.md': 'new',
  }), packages), { kind: 'docs' });
});

test('rechecks script tests and fixtures while reusing unchanged package validation', () => {
  assert.deepEqual(selectCheckMode(baseline, current({
    'scripts/tests/check-mode.test.mjs': 'changed',
    'scripts/tests/fixture.mjs': 'new',
    'docs/maintenance/validation.md': 'changed',
  }), packages), { kind: 'script-tests' });
  assert.deepEqual(selectCheckMode(baseline, current({
    'scripts/check-runner.mjs': 'changed',
  }), packages), { kind: 'full' });
});

test('rechecks evaluation tooling without invalidating unchanged package outputs', () => {
  assert.deepEqual(selectCheckMode(baseline, current({
    'scripts/ab-eval.mjs': 'changed',
    'scripts/ab-eval/manifest.mjs': 'changed',
    'scripts/tests/ab-eval-manifest.test.mjs': 'changed',
  }), packages), { kind: 'script-tests' });
  assert.deepEqual(selectCheckMode(baseline, current({
    'scripts/package-consumer-runner.mjs': 'changed',
    'scripts/ab-eval/manifest.mjs': 'changed',
  }), packages), { kind: 'full' });
});

test('rechecks unpublished package evaluation scripts as tooling inputs', () => {
  const unpublished = packages.map((item) => ({ ...item,
    manifest: { files: ['dist', 'README.md'] } }));
  const script = 'packages/leaf/evaluation/export-h8-pack.mjs';
  assert.deepEqual(selectCheckMode(baseline, current({
    [script]: 'changed',
    'scripts/tests/ab-eval-h8-export.test.mjs': 'changed',
    'docs/maintenance/ab-evaluation.md': 'changed',
  }), unpublished), { kind: 'script-tests' });
  assert.deepEqual(selectCheckMode(baseline, current({
    [script]: 'changed',
    'packages/leaf/src/index.ts': 'changed',
  }), unpublished), { kind: 'full' });
  const published = unpublished.map((item) => item.name === '@example/leaf'
    ? { ...item, manifest: { files: ['dist', 'evaluation'] } } : item);
  assert.deepEqual(selectCheckMode(baseline, current({ [script]: 'changed' }),
    published), { kind: 'full' });
  const wholePackage = unpublished.map((item) => item.name === '@example/leaf'
    ? { ...item, manifest: { files: ['./'] } } : item);
  assert.deepEqual(selectCheckMode(baseline, current({ [script]: 'changed' }),
    wholePackage), { kind: 'full' });
});

test('evaluation tooling reuse rejects mixed package source and missing inputs', () => {
  assert.deepEqual(selectCheckMode(baseline, current({
    'scripts/ab-eval/manifest.mjs': 'changed',
    'packages/core/src/index.ts': 'changed',
  }), packages), { kind: 'full' });
  assert.deepEqual(selectCheckMode(baseline, current({
    'scripts/ab-eval/manifest.mjs': null,
  }), packages), { kind: 'full' });
});

test('selects changed packages and transitive dependants from workspace metadata', () => {
  assert.deepEqual(selectCheckMode(baseline, current({
    'packages/core/src/index.ts': 'changed',
  }), packages), { kind: 'packages', packageNames: ['@example/core', '@example/leaf'] });
  assert.deepEqual(selectCheckMode(baseline, current({
    'packages/leaf/src/index.ts': 'changed',
    'packages/other/src/index.ts': 'changed',
  }), packages), { kind: 'packages', packageNames: ['@example/leaf', '@example/other'] });
  assert.deepEqual(selectCheckMode(baseline, current({
    'packages/core/tests/core.test.ts': 'new',
  }), packages), { kind: 'leaf', packageName: '@example/core' });
  assert.deepEqual(selectCheckMode(baseline, current({
    'packages/core/src/index.ts': 'changed',
    'packages/other/src/index.ts': 'changed',
  }), packages), { kind: 'full' });
});

test('follows transitive dependants in package order', () => {
  const chain = [
    ...packages,
    { name: '@example/grandchild', directory: 'packages/grandchild',
      workspaceDependencies: ['@example/leaf'] },
  ];
  assert.deepEqual(selectCheckMode(baseline, current({
    'packages/core/src/index.ts': 'changed',
  }), chain), { kind: 'packages',
    packageNames: ['@example/core', '@example/leaf', '@example/grandchild'] });
});

test('falls back to full validation for dependency, manifest, root, and environment changes', () => {
  for (const candidate of [
    current({ 'package.json': 'changed' }),
    current({ 'packages/leaf/package.json': 'changed' }),
    current({ 'scripts/tests/check-mode.test.mjs': 'changed',
      'packages/other/src/index.ts': 'changed' }),
    current({}, 'changed-environment'),
  ]) {
    assert.deepEqual(selectCheckMode(baseline, candidate, packages), { kind: 'full' });
  }
});

test('treats removed files and unrecognized package paths as full validation', () => {
  const removed = current({});
  delete removed.files['packages/leaf/src/index.ts'];
  assert.deepEqual(selectCheckMode(baseline, removed, packages), { kind: 'full' });
  assert.deepEqual(selectCheckMode(baseline, current({
    'packages/leaf/src/index.ts': null,
  }), packages), { kind: 'full' });
  assert.deepEqual(selectCheckMode(baseline, current({
    'packages/leaf/scripts/build.mjs': 'new',
  }), packages), { kind: 'full' });
});
