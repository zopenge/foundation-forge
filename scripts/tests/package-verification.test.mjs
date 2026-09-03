import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createConsumerConfiguration,
  createConsumerImportScript,
  createPnpmWorkspaceConfiguration,
  loadPackageVerification,
  verifyBrowserBoundaries,
} from '../package-verification.mjs';
import { preparePackagesForPacking } from '../package-consumer-runner.mjs';

const createPackage = async (context, {
  bins = [],
  browserExports = ['.'],
  files = { 'dist/index.js': 'export const value = 1;\n' },
  name = '@example/package',
  packageConsumer = false,
} = {}) => {
  const packageRoot = await mkdtemp(join(tmpdir(), 'foundation-forge-package-'));
  context.after(() => rm(packageRoot, { force: true, recursive: true }));
  for (const [relativePath, contents] of Object.entries(files)) {
    const path = join(packageRoot, relativePath);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, contents);
  }
  const exports = [
    {
      importTarget: './dist/index.js',
      specifier: name,
      subpath: '.',
      typesTarget: './dist/index.d.ts',
    },
  ];
  await writeFile(join(packageRoot, 'package.verify.json'), JSON.stringify({ browserExports }));
  if (packageConsumer) {
    await mkdir(join(packageRoot, 'package-consumer'), { recursive: true });
    await writeFile(join(packageRoot, 'package-consumer', 'verify.mjs'), 'export {};\n');
  }
  return { bins, exports, name, packageRoot, version: '1.0.0', workspaceDependencies: [] };
};

test('loads explicit browser exports and discovers an adjacent consumer smoke', async (context) => {
  const packageValue = await createPackage(context, { packageConsumer: true });

  const verification = await loadPackageVerification(packageValue);

  assert.deepEqual(verification.browserExports, ['.']);
  assert.equal(verification.consumerScript, join(packageValue.packageRoot, 'package-consumer', 'verify.mjs'));
});

test('rejects missing verification metadata and unknown browser exports', async (context) => {
  const packageValue = await createPackage(context);
  await rm(join(packageValue.packageRoot, 'package.verify.json'));
  await assert.rejects(loadPackageVerification(packageValue), /package\.verify\.json/u);

  await writeFile(
    join(packageValue.packageRoot, 'package.verify.json'),
    JSON.stringify({ browserExports: ['./browser'] }),
  );
  await assert.rejects(loadPackageVerification(packageValue), /unknown browser export/u);
});

test('requires a consumer smoke for packages that expose a binary', async (context) => {
  const packageValue = await createPackage(context, {
    bins: [{ name: 'example', target: './dist/cli.js' }],
  });

  await assert.rejects(loadPackageVerification(packageValue), /binary.*consumer smoke/u);
});

test('rejects direct and transitive Node-only imports from browser exports', async (context) => {
  const direct = await createPackage(context, {
    files: { 'dist/index.js': "import 'node:fs';\n" },
  });
  direct.verification = await loadPackageVerification(direct);
  await assert.rejects(verifyBrowserBoundaries([direct]), /node:fs/u);

  const core = await createPackage(context, {
    files: { 'dist/index.js': "import 'ws';\n" },
    name: '@example/core',
  });
  const provider = await createPackage(context, {
    files: { 'dist/index.js': "import '@example/core';\n" },
    name: '@example/provider',
  });
  core.verification = await loadPackageVerification(core);
  provider.verification = await loadPackageVerification(provider);
  await assert.rejects(verifyBrowserBoundaries([core, provider]), /ws/u);
});

test('generates exact dependencies and overrides for every discovered package', () => {
  const packages = [
    { name: '@example/core', version: '1.0.0' },
    { name: '@example/provider', version: '2.0.0-rc.1' },
  ];
  const references = new Map([
    ['@example/core', 'file:../packs/core.tgz'],
    ['@example/provider', 'file:../packs/provider.tgz'],
  ]);

  assert.deepEqual(createConsumerConfiguration({ packages, references }), {
    dependencies: {
      '@example/core': 'file:../packs/core.tgz',
      '@example/provider': 'file:../packs/provider.tgz',
    },
    overrides: {
      '@example/core': 'file:../packs/core.tgz',
      '@example/provider': 'file:../packs/provider.tgz',
    },
  });
});

test('generates imports for every public export without a package catalogue', () => {
  const packages = [
    {
      exports: [
        { specifier: '@example/provider/browser' },
        { specifier: '@example/provider/node' },
      ],
      name: '@example/provider',
    },
    { exports: [{ specifier: '@example/core' }], name: '@example/core' },
  ];

  assert.equal(createConsumerImportScript(packages), [
    'await import("@example/core");',
    'await import("@example/provider/browser");',
    'await import("@example/provider/node");',
    "console.log('Clean package consumer imported every public entry.');",
    '',
  ].join('\n'));
});

test('preserves workspace policy while appending generated overrides', () => {
  assert.equal(createPnpmWorkspaceConfiguration('packages: []\nallowBuilds:\n  native: true\n', {
    '@example/core': 'file:../core.tgz',
  }), [
    'packages: []',
    'allowBuilds:',
    '  native: true',
    '',
    'overrides:',
    '  "@example/core": "file:../core.tgz"',
    '',
  ].join('\n'));
});

test('removes stale build output before rebuilding packages for packing', async (context) => {
  const packageRoot = await mkdtemp(join(tmpdir(), 'foundation-forge-clean-build-'));
  context.after(() => rm(packageRoot, { force: true, recursive: true }));
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await writeFile(join(packageRoot, 'dist', 'stale.js'), 'stale\n');

  await preparePackagesForPacking({
    build: async () => {
      await assert.rejects(readdir(join(packageRoot, 'dist')), { code: 'ENOENT' });
      await mkdir(join(packageRoot, 'dist'), { recursive: true });
      await writeFile(join(packageRoot, 'dist', 'fresh.js'), 'fresh\n');
    },
    model: { packages: [{ packageRoot }] },
  });

  assert.deepEqual(await readdir(join(packageRoot, 'dist')), ['fresh.js']);
});
