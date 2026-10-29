import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openCheckCancellation } from './check-cancellation.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const observer = new URL('./node-test-worker-observer.mjs', import.meta.url).href;

/** 一个监督Job内逐文件隔离；失败、取消与输出关闭后都不启动后续文件。 */
export async function runScriptFiles(files, { spawnCommand = spawn, env = process.env, signal } = {}) {
  if (!files.length || new Set(files).size !== files.length || files.some(file =>
    dirname(file) !== resolve(repositoryRoot, 'scripts/tests') || !file.endsWith('.test.mjs'))) {
    throw new Error('QUICK_SCRIPT_SELECTION_INVALID');
  }
  for (const file of files) {
    signal?.throwIfAborted();
    await new Promise((accept, reject) => {
      const child = spawnCommand(process.execPath, ['--import', observer, '--test', '--experimental-test-isolation=none', '--test-concurrency=1', file], {
        cwd: repositoryRoot, stdio: 'inherit', shell: false, windowsHide: true, signal,
        env: { ...env, NODE_TEST_CONTEXT: undefined, FORGE_NODE_TEST_FILE: file },
      });
      let failure;
      child.once('error', error => { failure = error; });
      child.once('close', (code, termination) => {
        if (signal?.aborted) reject(signal.reason);
        else if (failure) reject(failure);
        else if (code === 0) accept();
        else reject(new Error(`script test failed: ${file} (${String(code)}, ${String(termination)})`));
      });
    });
    signal?.throwIfAborted();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cancellation = openCheckCancellation();
  try {
    const files = process.argv.slice(2);
    await runScriptFiles(files, { signal: cancellation.signal });
    process.stdout.write(`Script tests passed: ${files.length} isolated files.\n`);
  } catch (error) { process.stderr.write(`${error?.stack ?? error}\n`); process.exitCode = 1; }
  finally { cancellation.close(); }
}
