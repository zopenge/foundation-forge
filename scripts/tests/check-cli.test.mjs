import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { collectDistDigests, collectTarballDigests, collectWorkspaceFingerprint } from '../check-fingerprint.mjs';

const execute = promisify(execFile);
// 执行真实 CLI 与收据写入；完整构建/打包边界由本夹具的子进程替身控制。
const createWorkspace = async (context, scenario) => {
  const base = resolve(import.meta.dirname, '../../tmp/tests');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(resolve(base, 'check-cli-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const put = async (path, value) => {
    const target = resolve(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, value);
  };
  await put('.gitignore', 'tmp/\nnode_modules/\npackages/*/dist/\n');
  await put('package.json', '{"private":true,"type":"module"}');
  await put('node_modules/.modules.yaml', 'fixture: true\n');
  await put('packages/fixture/src/index.js', 'export const value = 1;\n');
  await put('packages/fixture/dist/index.js', 'export const value = 1;\n');
  await put('tmp/check-cache/packs/fixture.tgz', 'controlled package bytes');
  await put('tmp/check-cache/packs/tarballs.json', '{"fixture":"fixture.tgz"}');
  const packages = [{ name: 'fixture', directory: 'packages/fixture', packageRoot: resolve(root, 'packages/fixture') }];
  await mkdir(resolve(root, 'scripts'));
  for (const name of ['check-runner.mjs', 'check-options.mjs'])
    await copyFile(new URL('../' + name, import.meta.url), resolve(root, 'scripts', name));
  for (const module of ['check-fingerprint', 'check-cancellation'])
    await put(`scripts/${module}.mjs`, `export * from ${JSON.stringify(new URL(`../${module}.mjs`, import.meta.url).href)};\n`);
  await put('scripts/workspace-packages.mjs', `export const discoverWorkspacePackageModel = async () => (${JSON.stringify({ packages })});\n`);
  await put('scripts/package-manager-command.mjs', `export const createPackageManagerInvocation = (_manager, args) => ({command:process.execPath,args:[${JSON.stringify(resolve(root, 'tmp/full-boundary.mjs'))},...args]});\n`);
  await put('tmp/full-boundary.mjs', `
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
assert.deepEqual(process.argv.slice(2), ['run', 'check:full:run']);
await writeFile('tmp/full-started', 'started');
if (${JSON.stringify(scenario)} === 'failed') process.exit(1);
if (${JSON.stringify(scenario)} === 'drift') await writeFile('packages/fixture/src/index.js', 'changed during validation');
`);
  await execute('git', ['init', '--quiet'], { cwd: root, windowsHide: true });
  const state = { ...await collectWorkspaceFingerprint(root), distDigests: await collectDistDigests(packages),
    tarballDigests: await collectTarballDigests(packages, resolve(root, 'tmp/check-cache/packs')) };
  const receiptPath = resolve(root, 'tmp/check-cache/state.json'), receipt = JSON.stringify(state);
  await writeFile(receiptPath, receipt);
  const run = async args => {
    try {
      return { ...await execute(process.execPath, [resolve(root, 'scripts/check-runner.mjs'), ...args],
        { cwd: root, windowsHide: true }), code: 0 };
    } catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  };
  return { root, run, receipt, receiptPath, state };
};

test('显式 full CLI 成功后写入当前 full 收据，缺少或未知参数不能复用成功', async context => {
  const workspace = await createWorkspace(context, 'success');
  for (const args of [[], ['--unknown']]) {
    const rejected = await workspace.run(args);
    assert.equal(rejected.code, 1); assert.match(rejected.stderr, /CHECK_ARGUMENT_INVALID/u);
    assert.equal(await readFile(workspace.receiptPath, 'utf8'), workspace.receipt);
    await assert.rejects(readFile(resolve(workspace.root, 'tmp/full-started')), { code: 'ENOENT' });
  }
  const result = await workspace.run(['--full']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(workspace.receiptPath, 'utf8')),
    { ...workspace.state, validation: { schemaVersion: 1, kind: 'full' } });
  assert.equal(await readFile(resolve(workspace.root, 'tmp/full-started'), 'utf8'), 'started');
});

test('完整阶段失败或源码漂移均保留先前收据', async context => {
  for (const scenario of ['failed', 'drift']) {
    const workspace = await createWorkspace(context, scenario);
    const result = await workspace.run(['--full']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, scenario === 'drift' ? /inputs changed/u : /exited with 1/u);
    assert.equal(await readFile(workspace.receiptPath, 'utf8'), workspace.receipt);
  }
});
