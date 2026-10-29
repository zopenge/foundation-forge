import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openCheckCancellation } from '../check-cancellation.mjs';
import { findPnpmCliPath } from '../package-manager-command.mjs';

const require = createRequire(import.meta.url);
const shimRoot = fileURLToPath(new URL('./', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
// 这是已审阅实现的兼容性指纹；版本仍由根 packageManager 决定，升级必须重新审阅。
const reviewedRuntimes = {
  '10.33.2': {
    entry: 'b276da51dc8ca5b0d3ee3371695b50fc8b3244b281b091c63a3f082a88dadeb9',
    bundle: 'a04379c877cf74b4cbc585ab3a14fd52eea2d52b5aa0fb854cbd4485cd73b347',
  },
};

export const validatePnpmRuntime = ({ cliPath, packageManager, read = readFileSync,
  digest = bytes => createHash('sha256').update(bytes).digest('hex') }) => {
  if (typeof cliPath !== 'string' || !win32.isAbsolute(cliPath)) throw new Error('an absolute pnpm CLI path is required');
  const packageRoot = win32.resolve(win32.dirname(cliPath), '..');
  const manifest = JSON.parse(read(win32.resolve(packageRoot, 'package.json'), 'utf8'));
  if (manifest.name !== 'pnpm' || packageManager !== 'pnpm@' + manifest.version
    || !reviewedRuntimes[manifest.version]) throw new Error('pnpm version has no reviewed hidden lifecycle adapter');
  const entry = manifest.bin?.pnpm;
  if (typeof entry !== 'string' || win32.isAbsolute(entry)
    || win32.resolve(packageRoot, entry).toLowerCase() !== win32.resolve(cliPath).toLowerCase())
    throw new Error('pnpm CLI entry does not match the package pnpm mapping');
  if (digest(read(cliPath)) !== reviewedRuntimes[manifest.version].entry)
    throw new Error('pnpm CLI entry differs from the reviewed implementation');
  if (digest(read(win32.resolve(packageRoot, 'dist/pnpm.cjs'))) !== reviewedRuntimes[manifest.version].bundle)
    throw new Error('pnpm bundle differs from the reviewed hidden lifecycle implementation');
};

export const createPnpmEnvironment = ({ env, cliPath, nodeExecutable, directory = shimRoot }) => {
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
  const path = [directory, ...(env[pathKey] ?? '').split(';')
    .filter(value => value && win32.resolve(value).toLowerCase() !== win32.resolve(directory).toLowerCase())].join(';');
  return { ...env, [pathKey]: path, npm_execpath: resolve(directory, 'pnpm.cjs'),
    FORGE_CHECK_REAL_PNPM_CLI: cliPath, FORGE_CHECK_NODE: nodeExecutable };
};

export const applyPnpmEnvironment = (env, next) => {
  const changed = Object.entries(next).filter(([key, value]) => env[key] !== value);
  const previous = changed.map(([key]) => [key, env[key]]);
  for (const [key, value] of changed) env[key] = value;
  // 保留 Windows process.env 的大小写语义，不用普通对象替换它。
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) {
        if (!Reflect.deleteProperty(env, key)) throw new TypeError(`Cannot delete property '${key}'`);
      } else env[key] = value;
    }
  };
};

// 补齐已审阅 pnpm lifecycle / execa 的 Node 启动边界；不更换 shell 或解释 argv。
export const installPnpmSpawnPolicy = (commands, assertRunning) => {
  const saved = new Map();
  for (const name of ['spawn', 'spawnSync']) {
    const original = commands[name];
    const wrapped = function (command, args, options) {
      assertRunning();
      const values = [...arguments];
      const optionIndex = Array.isArray(args) || args == null ? 2 : 1;
      const selected = optionIndex === 2 ? options : args;
      // 非法参数交给 Node 原校验；补参数不能将原本的 TypeError 变成真实启动。
      if ((args != null && !Array.isArray(args) && typeof args !== 'object')
        || (selected !== undefined && (selected === null || typeof selected !== 'object' || Array.isArray(selected)))
        || (selected?.windowsHide != null && typeof selected.windowsHide !== 'boolean'))
        return Reflect.apply(original, this, values);
      values[optionIndex] = { ...selected, windowsHide: true };
      return Reflect.apply(original, this, values);
    };
    saved.set(name, { original, wrapped }); commands[name] = wrapped;
  }
  return () => {
    for (const [name, { original, wrapped }] of saved) if (commands[name] === wrapped) commands[name] = original;
  };
};

export const runHiddenPnpm = () => {
  if (process.platform !== 'win32') throw new Error('the reviewed hidden pnpm entry is Windows-only');
  const entry = resolve(shimRoot, 'pnpm.cjs');
  if (!process.argv[1] || resolve(process.argv[1]).toLowerCase() !== entry.toLowerCase()
    || !require.main?.filename || resolve(require.main.filename).toLowerCase() !== entry.toLowerCase())
    throw new Error('hidden pnpm must be the explicit CommonJS main entry');
  const cliPath = process.env.FORGE_CHECK_REAL_PNPM_CLI ?? findPnpmCliPath();
  if (resolve(cliPath).toLowerCase() === entry.toLowerCase()) throw new Error('hidden pnpm entry cannot load itself');
  const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'));
  validatePnpmRuntime({ cliPath, packageManager: manifest.packageManager });
  const restoreEnvironment = applyPnpmEnvironment(process.env,
    createPnpmEnvironment({ env: process.env, cliPath, nodeExecutable: process.execPath }));
  let cancellation, restore;
  const close = () => {
    restore?.(); cancellation?.close(); restoreEnvironment();
  };
  try {
    cancellation = openCheckCancellation();
    cancellation.assertRunning();
    restore = installPnpmSpawnPolicy(childProcess, cancellation.assertRunning);
    // require.main 仍是 pnpm.cjs；真实 pnpm 会将此入口传给 lifecycle 的 npm_execpath。
    process.once('exit', close);
    return require(cliPath);
  } catch (error) {
    process.removeListener('exit', close); close(); throw error;
  }
};
