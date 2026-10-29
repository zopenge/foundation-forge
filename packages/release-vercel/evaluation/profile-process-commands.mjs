import childProcess from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';

// 只记录外部命令类别、时长和退出码，不采集参数、环境、输出或凭据。
const temporary = fileURLToPath(new URL('../../../.tmp/', import.meta.url));
const directory = resolve(process.env.FORGE_CHECK_PROFILE_DIRECTORY ?? resolve(temporary, 'check-performance-profile'));
const contained = relative(temporary, directory);
if (!contained || contained === '..' || contained.startsWith('../') || contained.startsWith('..\\') || isAbsolute(contained)) {
  throw Object.assign(new Error('PROFILE_PATH_INVALID'), { code: 'PROFILE_PATH_INVALID' });
}
mkdirSync(directory, { recursive: true });
const output = resolve(directory, `commands-${process.pid}.jsonl`);
const record = (command, started, exitCode, details = {}) => appendFileSync(output,
  `${JSON.stringify({ command: basename(command), started, milliseconds: performance.now() - started, exitCode, ...details })}\n`);
const originalSpawn = childProcess.spawn;
const gitOperations = new Set(['ls-files', 'ls-tree', 'rev-parse', 'cat-file', 'status', 'diff', 'show', 'config', 'init', 'add', 'commit', 'clone', 'checkout', 'fetch', 'push', 'ls-remote']);
childProcess.spawn = function (command, ...args) {
  const started = performance.now(); let exitMilliseconds;
  const child = Reflect.apply(originalSpawn, this, [command, ...args]);
  const operation = /^git(?:\.exe)?$/iu.test(basename(command)) && Array.isArray(args[0])
    ? args[0].find(value => gitOperations.has(value)) : undefined;
  child.once('exit', () => { exitMilliseconds = performance.now() - started; });
  child.once('close', code => record(command, started, code, { method: 'spawn', exitMilliseconds, ...(operation ? { operation } : {}) }));
  return child;
};
const originalExecFile = childProcess.execFile;
childProcess.execFile = function (command, ...args) {
  const started = performance.now();
  const child = Reflect.apply(originalExecFile, this, [command, ...args]);
  child.once('close', code => record(command, started, code));
  return child;
};
// Node 的定制 promisifier 同时保留 stdout/stderr 对象和 Promise.child。
Object.defineProperty(childProcess.execFile, promisify.custom, {
  value: function (command, ...args) {
    const started = performance.now();
    const pending = Reflect.apply(originalExecFile[promisify.custom], this, [command, ...args]);
    pending.child.once('close', code => record(command, started, code));
    return pending;
  },
});
const originalSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = function (command, ...args) {
  const started = performance.now();
  const result = Reflect.apply(originalSpawnSync, this, [command, ...args]);
  record(command, started, result.status);
  return result;
};
syncBuiltinESMExports();
