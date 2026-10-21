import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers';
import test from 'node:test';

import {
  createConsumerConfiguration,
  createConsumerImportScript,
  createPnpmWorkspaceConfiguration,
  loadPackageVerification,
  verifyBrowserBoundaries,
} from '../package-verification.mjs';
import * as packageRunner from '../package-consumer-runner.mjs';

const { preparePackagesForPacking, runBounded, runCaptured, runConsumerChecks } = packageRunner;

test('documentation links reject missing local targets and accept present targets', async (context) => {
  assert.equal(typeof packageRunner.verifyDocumentationLinks, 'function');
  await mkdir(join('.tmp', 'tests'), { recursive: true });
  const root = await mkdtemp(join('.tmp', 'tests', 'documentation-links-'));
  context.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(join(root, 'README.md'), '[target](./target.md)\n');
  await assert.rejects(packageRunner.verifyDocumentationLinks(root), /missing local target/u);
  await writeFile(join(root, 'target.md'), '# Target\n');
  await packageRunner.verifyDocumentationLinks(root);
});

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

test('bounded package work preserves order and drains active jobs after failure', async () => {
  assert.equal(typeof runBounded, 'function');
  const pending = () => {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };
  const gates = [pending(), pending(), pending()];
  const started = [pending(), pending(), pending()];
  const jobs = [];
  let active = 0;
  let peak = 0;
  const work = runBounded(['first', 'second', 'third'], 2, async (name, index) => {
    jobs.push(name);
    active += 1;
    peak = Math.max(peak, active);
    started[index].resolve();
    try { return await gates[index].promise; }
    finally { active -= 1; }
  });
  await Promise.all([started[0].promise, started[1].promise]);
  assert.deepEqual(jobs, ['first', 'second']);
  gates[1].resolve('second-result');
  await started[2].promise;
  gates[0].resolve('first-result');
  gates[2].resolve('third-result');
  assert.deepEqual(await work, ['first-result', 'second-result', 'third-result']);
  assert.equal(peak, 2);

  const secondStarted = pending();
  const finishSecond = pending();
  let secondFinished = false;
  const failed = runBounded(['first', 'second', 'never'], 2, async (name) => {
    jobs.push(name);
    if (name === 'first') {
      await secondStarted.promise;
      throw new Error('first failed');
    }
    secondStarted.resolve();
    await finishSecond.promise;
    secondFinished = true;
    return name;
  });
  await secondStarted.promise;
  await new Promise((resolve) => setImmediate(resolve));
  finishSecond.resolve();
  await assert.rejects(failed, /first failed/u);
  assert.deepEqual(jobs.slice(3), ['first', 'second']);
  assert.equal(secondFinished, true);

  const laterFailure = pending();
  const concurrentFailures = runBounded(['first', 'second'], 2, async (name) => {
    if (name === 'first') throw new Error('first failure');
    await laterFailure.promise;
    throw new Error('later failure');
  });
  await new Promise((resolve) => setImmediate(resolve));
  laterFailure.resolve();
  await assert.rejects(concurrentFailures, /first failure/u);
});

test('captured package commands retain success and failure output', async () => {
  assert.equal(typeof runCaptured, 'function');
  const output = await runCaptured(process.execPath,
    ['-e', "process.stdout.write('packed\\n')"], { cwd: process.cwd() });
  assert.equal(output, 'packed');
  await assert.rejects(runCaptured(process.execPath,
    ['-e', "process.stderr.write('invalid tarball\\n'); process.exit(7)"],
    { cwd: process.cwd() }), /status 7[\s\S]*invalid tarball/u);
});

test('consumer imports and smokes start together and drain on failure', async () => {
  assert.equal(typeof runConsumerChecks, 'function');
  let finishSmoke;
  const smokeDone = new Promise((resolve) => { finishSmoke = resolve; });
  const started = [];
  const work = runConsumerChecks({
    importCheck: async () => { started.push('imports'); throw new Error('import failed'); },
    smokeChecks: async () => { started.push('smokes'); await smokeDone; },
  });
  assert.deepEqual(started, ['imports', 'smokes']);
  let settled = false;
  work.catch(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  finishSmoke();
  await assert.rejects(work, /import failed/u);
  assert.equal(settled, true);

  let smokeStarted = false;
  await assert.rejects(runConsumerChecks({
    importCheck: () => { throw new Error('synchronous import failure'); },
    smokeChecks: async () => { smokeStarted = true; },
  }), /synchronous import failure/u);
  assert.equal(smokeStarted, true);
});
