import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setImmediate } from 'node:timers';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  collectDistDigests, collectTarballDigests, collectWorkspaceFingerprint,
} from '../check-fingerprint.mjs';
import { runPackages, runScriptTests, verifyDist } from '../check-runner.mjs';

const execute = promisify(execFile);

// 在独立工作区执行真实检查入口，仅替换会启动构建、安装和打包的外部边界。
const createCheckWorkspace = async (context, scenario) => {
  await mkdir(resolve('.tmp/tests'), { recursive: true });
  const root = await mkdtemp(resolve('.tmp/tests', 'check-cli-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const put = async (path, text) => {
    const target = resolve(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text);
  };
  await put('.gitignore', '.tmp/\nnode_modules/\npackages/*/dist/\n');
  await put('package.json', JSON.stringify({ private: true, type: 'module' }));
  await put('README.md', '# Workspace\n');
  await put('node_modules/.modules.yaml', 'fixture: true\n');
  await put('.tmp/scenario.json', JSON.stringify(scenario));
  const packages = ['leaf', 'other', 'third'].map((name) => ({
    name, directory: 'packages/' + name, packageRoot: resolve(root, 'packages', name),
    manifest: { scripts: {} }, workspaceDependencies: [],
  }));
  for (const { directory, name } of packages) {
    await put(directory + '/src/index.js', 'export const value = 1;\n');
    await put(directory + '/dist/index.js', 'export const value = 1;\n');
    await put(directory + '/README.md', '# Package\n');
    await put('.tmp/check-cache/packs/' + name + '.tgz', 'verified ' + name);
  }
  await put('.tmp/check-cache/packs/tarballs.json',
    JSON.stringify(Object.fromEntries(packages.map(({ name }) => [name, name + '.tgz']))));
  for (const name of ['check-runner.mjs', 'check-mode.mjs']) {
    await mkdir(resolve(root, 'scripts'), { recursive: true });
    await copyFile(new URL('../' + name, import.meta.url), resolve(root, 'scripts', name));
  }
  const fingerprintUrl = JSON.stringify(new URL('../check-fingerprint.mjs', import.meta.url).href);
  await put('scripts/check-fingerprint.mjs', [
    'import { readFile, writeFile } from "node:fs/promises";',
    'import { resolve } from "node:path";',
    'import * as real from ' + fingerprintUrl + ';',
    'export const collectWorkspaceFingerprint = real.collectWorkspaceFingerprint;',
    'export const collectTarballDigests = real.collectTarballDigests;',
    'let changed = false;',
    'export const collectDistDigests = async (...args) => {',
    '  const result = await real.collectDistDigests(...args);',
    '  const scenario = JSON.parse(await readFile(resolve(".tmp/scenario.json"), "utf8"));',
    '  if (scenario.kind === "cached-input" && !changed) {',
    '    changed = true;',
    '    await writeFile(resolve("packages/leaf/src/index.js"), "changed during verification");',
    '  }',
    '  return result;',
    '};',
  ].join('\n'));
  await put('scripts/workspace-packages.mjs',
    'export const discoverWorkspacePackageModel = async () => (' +
    JSON.stringify({ packages }) + ');\n');
  const runnerUrl = JSON.stringify(new URL('../package-consumer-runner.mjs', import.meta.url).href);
  await put('scripts/package-consumer-runner.mjs', [
    'import { readFile, writeFile } from "node:fs/promises";',
    'import * as real from ' + runnerUrl + ';',
    'export const preparePackagesForPacking = real.preparePackagesForPacking;',
    'export const verifyDocumentationLinks = async (...args) => {',
    '  await real.verifyDocumentationLinks(...args);',
    '  const scenario = JSON.parse(await readFile(".tmp/scenario.json", "utf8"));',
    '  if (scenario.kind === "after-docs-input") {',
    '    await writeFile("packages/leaf/src/index.js", "changed during documentation check");',
    '  }',
    '};',
  ].join('\n'));
  await put('scripts/check-targeted-package.mjs', [
    'import { resolve } from "node:path";',
    'export const verifyTargetedPackages = async ({ packageNames }) => ({',
    '  targetTarballs: new Map(packageNames.map((name) =>',
    '    [name, resolve(".tmp", name + "-next.tgz")]))',
    '});',
  ].join('\n'));
  await put('scripts/package-manager-command.mjs', [
    'import { resolve } from "node:path";',
    'export const createPackageManagerInvocation = (_manager, args) => ({',
    '  command: process.execPath, args: [resolve(".tmp/fake-pnpm.mjs"), ...args]',
    '});',
  ].join('\n'));
  await put('.tmp/fake-pnpm.mjs', [
    'import { mkdir, readFile, writeFile } from "node:fs/promises";',
    'import { resolve } from "node:path";',
    'const args = process.argv.slice(2);',
    'const scenario = JSON.parse(await readFile(".tmp/scenario.json", "utf8"));',
    'if (args.at(-1) === "lint" && scenario.kind === "drift") {',
    '  await writeFile(resolve(scenario.path), "unverified output");',
    '}',
    'if (args.at(-1) === "build") {',
    '  const directory = resolve("packages", args[1], "dist");',
    '  await mkdir(directory, { recursive: true });',
    '  await writeFile(resolve(directory, "index.js"), "export const value = 2;");',
    '}',
  ].join('\n'));
  for (const { name } of packages) await put('.tmp/' + name + '-next.tgz', 'next ' + name);
  await execute('git', ['init', '--quiet'], { cwd: root, windowsHide: true });
  const state = {
    ...await collectWorkspaceFingerprint(root),
    distDigests: await collectDistDigests(packages),
    tarballDigests: await collectTarballDigests(packages, resolve(root, '.tmp/check-cache/packs')),
  };
  const receiptPath = resolve(root, '.tmp/check-cache/state.json');
  const receipt = JSON.stringify(state);
  await writeFile(receiptPath, receipt);
  const run = async () => {
    try {
      return { ...await execute(process.execPath, [resolve(root, 'scripts/check-runner.mjs')],
        { cwd: root, windowsHide: true }), code: 0 };
    } catch (error) {
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  };
  return { root, put, run, receipt, receiptPath };
};

test('单包检查拒绝包 README 与同批文档中的断链，失败不更新收据', async (context) => {
  for (const documentation of ['packages/leaf/README.md', 'docs/change.md']) {
    await context.test(documentation, async (child) => {
      const workspace = await createCheckWorkspace(child, { kind: 'none' });
      await workspace.put('packages/leaf/src/index.js', 'export const value = 2;\n');
      await workspace.put(documentation, '[missing](./absent.md)\n');
      const result = await workspace.run();
      assert.equal(result.code, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /missing local target/u);
      assert.equal(await readFile(workspace.receiptPath, 'utf8'), workspace.receipt);
    });
  }
});

test('文档与单包检查拒绝验证期间变化的复用产物和 tarball', async (context) => {
  for (const mode of ['docs', 'leaf']) {
    for (const path of ['packages/other/dist/index.js', '.tmp/check-cache/packs/other.tgz']) {
      await context.test(mode + '/' + path, async (child) => {
        const workspace = await createCheckWorkspace(child, { kind: 'drift', path });
        await workspace.put(mode === 'docs' ? 'README.md' : 'packages/leaf/src/index.js', 'changed\n');
        const result = await workspace.run();
        assert.equal(result.code, 1, result.stdout + result.stderr);
        assert.match(result.stderr, /verified.*outputs changed/u);
        assert.equal(await readFile(workspace.receiptPath, 'utf8'), workspace.receipt);
      });
    }
  }
});

test('精确缓存命中在返回通过前再次确认源码没有变化', async (context) => {
  const workspace = await createCheckWorkspace(context, { kind: 'cached-input' });
  const result = await workspace.run();
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /inputs changed/u);
  assert.equal(await readFile(workspace.receiptPath, 'utf8'), workspace.receipt);
});

test('所有复用路径在文档与产物验证结束后复核源码，再发布收据', async (context) => {
  for (const mode of ['docs', 'leaf', 'packages', 'script-tests']) {
    await context.test(mode, async (child) => {
      const workspace = await createCheckWorkspace(child, { kind: 'after-docs-input' });
      if (mode === 'docs') await workspace.put('README.md', '# Changed\n');
      else if (mode === 'script-tests') await workspace.put('scripts/tests/change.test.mjs', 'export {};\n');
      else await workspace.put('packages/leaf/src/index.js', 'export const value = 2;\n');
      if (mode === 'packages') await workspace.put('packages/other/src/index.js', 'export const value = 2;\n');
      const result = await workspace.run();
      assert.equal(result.code, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /inputs changed/u);
      assert.equal(await readFile(workspace.receiptPath, 'utf8'), workspace.receipt);
    });
  }
});

test('单包检查在构建前清除目标包的过期 dist 文件', async (context) => {
  const workspace = await createCheckWorkspace(context, { kind: 'none' });
  await workspace.put('packages/leaf/src/index.js', 'export const value = 2;\n');
  await workspace.put('packages/leaf/dist/obsolete.js', 'obsolete\n');
  const result = await workspace.run();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(await readdir(resolve(workspace.root, 'packages/leaf/dist')), ['index.js']);
});

test('a leaf check rebuilds its own dist while preserving verified dependency outputs', async () => {
  await mkdir(resolve('.tmp/tests'), { recursive: true });
  const root = await mkdtemp(resolve('.tmp/tests', 'check-runner-'));
  const packages = ['core', 'leaf', 'other'].map((name) => ({ name, packageRoot: resolve(root, name) }));
  try {
    for (const packageValue of packages) {
      await mkdir(resolve(packageValue.packageRoot, 'dist'), { recursive: true });
      await writeFile(resolve(packageValue.packageRoot, 'dist', 'index.js'), packageValue.name);
    }
    const baseline = { distDigests: await collectDistDigests(packages) };
    await writeFile(resolve(root, 'leaf', 'dist', 'index.js'), 'rebuilt leaf');
    assert.equal(await verifyDist({ packages }, baseline, { kind: 'leaf', packageName: 'leaf' }), true);
    assert.equal(await verifyDist({ packages }, baseline, { kind: 'cached' }), false);
    await writeFile(resolve(root, 'core', 'dist', 'index.js'), 'drifted dependency');
    assert.equal(await verifyDist({ packages }, baseline, { kind: 'leaf', packageName: 'leaf' }), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a package group may rebuild its own outputs but must preserve every other dist', async () => {
  await mkdir(resolve('.tmp/tests'), { recursive: true });
  const root = await mkdtemp(resolve('.tmp/tests', 'check-runner-'));
  const packages = ['core', 'leaf', 'other'].map((name) => ({ name, packageRoot: resolve(root, name) }));
  try {
    for (const packageValue of packages) {
      await mkdir(resolve(packageValue.packageRoot, 'dist'), { recursive: true });
      await writeFile(resolve(packageValue.packageRoot, 'dist', 'index.js'), packageValue.name);
    }
    const baseline = { distDigests: await collectDistDigests(packages) };
    await writeFile(resolve(root, 'core', 'dist', 'index.js'), 'rebuilt core');
    await writeFile(resolve(root, 'leaf', 'dist', 'index.js'), 'rebuilt leaf');
    const mode = { kind: 'packages', packageNames: ['core', 'leaf'] };
    assert.equal(await verifyDist({ packages }, baseline, mode), true);
    await writeFile(resolve(root, 'other', 'dist', 'index.js'), 'drifted other');
    assert.equal(await verifyDist({ packages }, baseline, mode), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a package group drains failed checks and never writes a success receipt', async () => {
  await mkdir(resolve('.tmp/tests'), { recursive: true });
  const root = await mkdtemp(resolve('.tmp/tests', 'check-runner-'));
  let finishScripts;
  const scripts = new Promise((resolve) => { finishScripts = resolve; });
  const calls = [];
  let persisted = false;
  try {
    const packages = ['core', 'leaf'].map((name) => ({
      name, packageRoot: resolve(root, name), manifest: { scripts: {} },
    }));
    for (const { packageRoot } of packages) await mkdir(packageRoot, { recursive: true });
    const work = runPackages({
      fingerprint: {}, model: { packages }, packageNames: ['core', 'leaf'],
      state: {}, tarballDigests: {},
      run: async (args) => {
        calls.push(args.join(' '));
        if (args.join(' ') === 'run test:scripts') await scripts;
        if (args.join(' ') === '--filter leaf run test:coverage') throw new Error('coverage failed');
      },
      targetedVerify: async () => ({ targetTarballs: new Map() }),
      persist: async () => { persisted = true; },
    });
    let settled = false;
    work.catch(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    finishScripts();
    await assert.rejects(work, /coverage failed/u);
    assert.deepEqual(calls.filter((call) => call.endsWith('run build')),
      ['--filter core run build', '--filter leaf run build']);
    assert.equal(persisted, false);
  } finally {
    finishScripts();
    await rm(root, { recursive: true, force: true });
  }
});

test('script test receipt runs both checks and verifies unchanged inputs and outputs', async () => {
  assert.equal(typeof runScriptTests, 'function');
  const calls = [];
  const state = { distDigests: { package: 'dist' }, tarballDigests: { package: 'tarball' } };
  await runScriptTests({
    fingerprint: { files: { test: 'changed' } },
    model: { packages: [] },
    state,
    run: async (args) => { calls.push(args.join(' ')); },
    assertInputs: async () => { calls.push('inputs'); },
    docsValid: async () => { calls.push('docs'); },
    distValid: async () => { calls.push('dist'); return true; },
    tarballsValid: async () => { calls.push('tarballs'); return state.tarballDigests; },
    persist: async (_fingerprint, dist, tarballs) => {
      calls.push('persist');
      assert.equal(dist, state.distDigests);
      assert.equal(tarballs, state.tarballDigests);
    },
  });
  assert.deepEqual(calls, ['run lint', 'run test:scripts', 'docs', 'dist', 'tarballs', 'inputs', 'persist']);
});

test('script test receipt drains active checks and rejects stale package outputs', async () => {
  let finishTests;
  const tests = new Promise((resolve) => { finishTests = resolve; });
  let persisted = false;
  const work = runScriptTests({
    fingerprint: {}, model: {}, state: {},
    run: async (args) => {
      if (args[1] === 'lint') throw new Error('lint failed');
      await tests;
    },
    assertInputs: async () => {},
    distValid: async () => true,
    tarballsValid: async () => ({}),
    persist: async () => { persisted = true; },
  });
  let settled = false;
  work.catch(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  finishTests();
  await assert.rejects(work, /lint failed/u);
  assert.equal(persisted, false);

  await assert.rejects(runScriptTests({
    fingerprint: {}, model: {}, state: {},
    run: async () => {},
    assertInputs: async () => {},
    docsValid: async () => {},
    distValid: async () => false,
    tarballsValid: async () => ({}),
    persist: async () => { persisted = true; },
  }), /verified package outputs changed/u);
  assert.equal(persisted, false);

  await assert.rejects(runScriptTests({
    fingerprint: {}, model: {}, state: {},
    run: async () => {},
    assertInputs: async () => {},
    docsValid: async () => {},
    distValid: async () => true,
    tarballsValid: async () => null,
    persist: async () => { persisted = true; },
  }), /verified package outputs changed/u);
  assert.equal(persisted, false);

  await assert.rejects(runScriptTests({
    fingerprint: {}, model: {}, state: {},
    run: async () => {},
    assertInputs: async () => {},
    docsValid: async () => { throw new Error('broken local link'); },
    distValid: async () => { throw new Error('should not inspect dist'); },
    tarballsValid: async () => ({}),
    persist: async () => { persisted = true; },
  }), /broken local link/u);
  assert.equal(persisted, false);
});
