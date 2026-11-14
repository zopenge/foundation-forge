import { lstat, realpath, rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// 不创建缺失路径；逐级拒绝重解析祖先后，再核对本轮记录的目录身份。
export const assertPackageVerificationIdentity = async ({ repositoryRoot, directory, identity }) => {
  const parts = relative(resolve(repositoryRoot), resolve(directory)).split(sep);
  if (parts.length < 2 || parts[0] !== 'tmp' || parts.some(part => !part || part.startsWith('.'))
    || isAbsolute(relative(resolve(repositoryRoot), resolve(directory)))) throw new Error('CLEANUP_PATH');
  const canonicalRepository = await realpath(repositoryRoot);
  let current = resolve(repositoryRoot), value;
  for (const [index, part] of parts.entries()) {
    current = resolve(current, part);
    value = await lstat(current, { bigint: true });
    if (value.isSymbolicLink() || !value.isDirectory()) throw new Error('CLEANUP_ANCESTOR');
    if (await realpath(current) !== resolve(canonicalRepository, ...parts.slice(0, index + 1))) throw new Error('CLEANUP_ANCESTOR');
  }
  if (String(value.dev) !== identity?.dev || String(value.ino) !== identity?.ino
    || await realpath(directory) !== identity?.canonicalPath) throw new Error('CLEANUP_IDENTITY');
};

export const removePackageVerificationDirectory = async ({ repositoryRoot, directory, identity, testRun, signal, mode }) => {
  if (!['in-process-async', 'supervised-sync'].includes(mode)) throw new Error('CLEANUP_MODE');
  if (testRun?.budget.summary().activeWorkers) throw new Error('CLEANUP_READERS_ACTIVE');
  if (mode === 'supervised-sync') { signal?.throwIfAborted(); testRun?.signal?.throwIfAborted(); }
  await assertPackageVerificationIdentity({ repositoryRoot, directory, identity });
  if (mode === 'in-process-async') await rm(directory, { recursive: true, force: true });
  else {
    if (!testRun || testRun.budget.summary().failed) throw new Error('CLEANUP_BUDGET_STOPPED');
    await testRun.run({ name: 'package verification cleanup', workers: 1, command: process.execPath,
      args: ['--import', new URL('./consumer-worker-observer.mjs', import.meta.url).href,
        fileURLToPath(new URL('./package-verification-cleanup-worker.mjs', import.meta.url)),
        JSON.stringify({ repositoryRoot, directory, identity })], cwd: repositoryRoot, signal });
    signal?.throwIfAborted(); testRun.signal?.throwIfAborted();
  }
  try { await lstat(directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('CLEANUP_DIRECTORY_REMAINS');
};

// 首败后不再预约新 scope；所有收尾仍执行，且不覆盖原始（含空值）失败。
export const finishPackageVerification = async ({ failures, own = false, testRun, signal, onBeforeCleanup, remove }) => {
  const recordCancellation = () => {
    const aborted = [signal, testRun?.signal].find(value => value?.aborted);
    if (aborted && !failures.includes(aborted.reason)) failures.push(aborted.reason);
  };
  recordCancellation();
  if (own && failures.length) {
    try { await testRun?.cancel?.(failures[0]); } catch (error) { failures.push(error); }
  }
  try { await onBeforeCleanup?.(failures[0], failures.length !== 0); }
  catch (error) { failures.push(error); }
  recordCancellation();
  const stopped = testRun?.budget.summary().failed;
  if (stopped && !failures.length) failures.push(new Error('CLEANUP_BUDGET_STOPPED'));
  try { await remove(!failures.length && testRun && !stopped ? 'supervised-sync' : 'in-process-async'); }
  catch (error) { failures.push(error); }
  if (own) {
    try { await testRun.finalize(); } catch (error) { failures.push(error); }
  }
  recordCancellation();
};
