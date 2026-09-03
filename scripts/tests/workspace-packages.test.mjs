import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createWorkspacePackageModel,
  discoverWorkspacePackageModel,
  normalizePackageBins,
  normalizePackageExports,
  parseJsonDocuments,
} from '../workspace-packages.mjs';

const createFixture = async (context, manifests) => {
  const root = await mkdtemp(join(tmpdir(), 'foundation-forge-workspace-'));
  context.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(join(root, 'package.json'), JSON.stringify({
    engines: { node: '>=22.14.0' },
    name: 'fixture-root',
    private: true,
    repository: { url: 'git+https://github.com/example/repository.git' },
  }));

  const listing = [{ name: 'fixture-root', path: root, private: true, version: '0.0.0' }];
  for (const [directory, manifest] of Object.entries(manifests)) {
    const path = join(root, directory);
    const normalizedManifest = {
      exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } },
      ...manifest,
    };
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'package.json'), JSON.stringify(normalizedManifest));
    listing.push({
      name: normalizedManifest.name,
      path,
      private: normalizedManifest.private === true,
      version: normalizedManifest.version,
    });
  }
  return { listing, root };
};

test('discovers public packages and sorts dependencies before dependants', async (context) => {
  const { listing, root } = await createFixture(context, {
    'packages/provider': {
      dependencies: { '@example/core': 'workspace:^' },
      name: '@example/provider',
      version: '1.0.0',
    },
    'packages/private': {
      name: '@example/private',
      private: true,
      version: '1.0.0',
    },
    'packages/core': {
      name: '@example/core',
      version: '1.0.0',
    },
  });

  const model = await createWorkspacePackageModel({ listing, repositoryRoot: root });

  assert.deepEqual(model.packages.map(({ name }) => name), [
    '@example/core',
    '@example/provider',
  ]);
  assert.deepEqual(model.packages[1].workspaceDependencies, ['@example/core']);
});

test('excludes private packages using the authoritative manifest', async (context) => {
  const { listing, root } = await createFixture(context, {
    'packages/private': {
      name: '@example/private',
      private: true,
      version: '1.0.0',
    },
    'packages/public': {
      name: '@example/public',
      version: '1.0.0',
    },
  });
  listing.find(({ name }) => name === '@example/private').private = false;

  const model = await createWorkspacePackageModel({ listing, repositoryRoot: root });

  assert.deepEqual(model.packages.map(({ name }) => name), ['@example/public']);
});

test('uses all four dependency kinds when sorting packages', async (context) => {
  const { listing, root } = await createFixture(context, {
    'packages/a': { devDependencies: { '@example/b': 'workspace:*' }, name: '@example/a', version: '1.0.0' },
    'packages/b': { optionalDependencies: { '@example/c': 'workspace:*' }, name: '@example/b', version: '1.0.0' },
    'packages/c': { peerDependencies: { '@example/d': 'workspace:*' }, name: '@example/c', version: '1.0.0' },
    'packages/d': { name: '@example/d', version: '1.0.0' },
  });

  const model = await createWorkspacePackageModel({ listing, repositoryRoot: root });

  assert.deepEqual(model.packages.map(({ name }) => name), [
    '@example/d',
    '@example/c',
    '@example/b',
    '@example/a',
  ]);
});

test('rejects dependency cycles and duplicate package names', async (context) => {
  const cycle = await createFixture(context, {
    'packages/a': { dependencies: { '@example/b': 'workspace:*' }, name: '@example/a', version: '1.0.0' },
    'packages/b': { dependencies: { '@example/a': 'workspace:*' }, name: '@example/b', version: '1.0.0' },
  });
  await assert.rejects(
    createWorkspacePackageModel({ listing: cycle.listing, repositoryRoot: cycle.root }),
    /dependency cycle/u,
  );

  const duplicate = await createFixture(context, {
    'packages/a': { name: '@example/same', version: '1.0.0' },
    'packages/b': { name: '@example/same', version: '1.0.0' },
  });
  await assert.rejects(
    createWorkspacePackageModel({ listing: duplicate.listing, repositoryRoot: duplicate.root }),
    /duplicate workspace package name/u,
  );
});

test('rejects invalid dependency metadata', async (context) => {
  const { listing, root } = await createFixture(context, {
    'packages/a': { dependencies: { '@example/b': 42 }, name: '@example/a', version: '1.0.0' },
    'packages/b': { name: '@example/b', version: '1.0.0' },
  });

  await assert.rejects(
    createWorkspacePackageModel({ listing, repositoryRoot: root }),
    /invalid dependencies/u,
  );
});

test('normalizes explicit exports and rejects wildcard exports', () => {
  assert.deepEqual(normalizePackageExports('@example/package', {
    '.': { import: './dist/index.js', types: './dist/index.d.ts' },
    './node': { import: './dist/node.js', types: './dist/node.d.ts' },
  }), [
    {
      importTarget: './dist/index.js',
      specifier: '@example/package',
      subpath: '.',
      typesTarget: './dist/index.d.ts',
    },
    {
      importTarget: './dist/node.js',
      specifier: '@example/package/node',
      subpath: './node',
      typesTarget: './dist/node.d.ts',
    },
  ]);
  assert.throws(
    () => normalizePackageExports('@example/package', { './*': './dist/*.js' }),
    /wildcard exports/u,
  );
});

test('normalizes string and object bin declarations', () => {
  assert.deepEqual(normalizePackageBins('@example/tool', './dist/cli.js'), [
    { name: 'tool', target: './dist/cli.js' },
  ]);
  assert.deepEqual(normalizePackageBins('@example/tool', {
    alpha: './dist/alpha.js',
    beta: './dist/beta.js',
  }), [
    { name: 'alpha', target: './dist/alpha.js' },
    { name: 'beta', target: './dist/beta.js' },
  ]);
});

test('parses JSON documents surrounded by package-manager warnings', () => {
  assert.deepEqual(parseJsonDocuments('warning before JSON\n{"name":"root"}\n[1,2]\n'), [
    { name: 'root' },
    [1, 2],
  ]);
});

test('discovers packages from pnpm recursive list output', async (context) => {
  const { listing, root } = await createFixture(context, {
    'packages/core': { name: '@example/core', version: '1.0.0' },
  });

  const model = await discoverWorkspacePackageModel({
    capturePnpm: async () => `pnpm warning\n${JSON.stringify(listing)}\n`,
    repositoryRoot: root,
  });

  assert.deepEqual(model.packages.map(({ name }) => name), ['@example/core']);
});
