import { randomUUID } from 'node:crypto';
import { closeSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { access, lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { recordTestWorkerEvent } from './test-worker-events.mjs';
import { ensureTestTemporaryDirectory } from './test-temporary-directory.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const failureDetails = (error, depth = 0) => {
  const value = {};
  for (const key of ['name', 'code']) {
    if (typeof error?.[key] === 'string') value[key] = error[key].slice(0, 128);
    else if (typeof error?.[key] === 'number' && Number.isFinite(error[key])) value[key] = error[key];
  }
  for (const key of ['reason', 'stage']) if (typeof error?.details?.[key] === 'string') value[key] = error.details[key].slice(0, 128);
  for (const key of ['nativeCode', 'exitCode']) if (typeof error?.details?.[key] === 'number' && Number.isFinite(error.details[key])) value[key] = error.details[key];
  if (error?.cause && depth < 2) value.cause = failureDetails(error.cause, depth + 1);
  return value;
};
const removeOwnedTemporary = async temporary => {
  let identity;
  try { identity = await lstat(temporary.path, { bigint: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!identity) return;
  if (identity.isSymbolicLink() || !identity.isDirectory()
    || String(identity.dev) !== temporary.device || String(identity.ino) !== temporary.inode
    || await realpath(temporary.path) !== temporary.realPath)
    throw new Error('test temporary directory identity changed; retained for inspection');
  await rm(temporary.path, { recursive: true, force: true });
};
export const discoverTestProcessSupervisor = async ({ packages, platform = process.platform }) => {
  const found = [];
  for (const value of packages) {
    const path = resolve(value.packageRoot, 'test-process-scope.mjs');
    try { await access(path); found.push(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (found.length !== 1) throw new Error('exactly one workspace test-process-scope.mjs adapter is required');
  const module = await import(pathToFileURL(found[0]).href);
  return module.createTestProcessSupervisor({ platform });
};

export const runTestProcess = async ({ supervisor, name, command, args = [], cwd, env = process.env, logRoot, signal }) => {
  signal?.throwIfAborted();
  const contained = relative(resolve(repositoryRoot, '.tmp'), resolve(logRoot));
  if (!contained || contained.startsWith('..') || isAbsolute(contained)) throw new Error('test logs must have an owned directory under .tmp');
  await ensureTestTemporaryDirectory(repositoryRoot, logRoot);
  const stdout = openSync(resolve(logRoot, 'stdout.log'), 'w'), stderr = openSync(resolve(logRoot, 'stderr.log'), 'w');
  const startedAt = new Date().toISOString(), start = performance.now();
  const jobId = randomUUID();
  let scope, completion, termination, failure, failurePhase, rootPid, temporary, startAttempted = false, failed = false, phase = 'temporary-create';
  const recordFailure = error => { if (!failed) { failed = true; failure = error; failurePhase = phase; } };
  const abort = () => {
    recordFailure(signal.reason);
    termination ??= Promise.resolve().then(() => scope?.terminate({ mode: 'force' })).catch(recordFailure);
  };
  try {
    signal?.throwIfAborted();
    const temporaryParent = await ensureTestTemporaryDirectory(repositoryRoot, resolve(repositoryRoot, '.tmp/test-work'));
    const path = await mkdtemp(resolve(temporaryParent, 'r-'));
    temporary = { path, status: 'active' };
    const temporaryIdentity = await lstat(path, { bigint: true });
    const canonicalTemporary = await realpath(path), inside = relative(temporaryParent, canonicalTemporary);
    if (!inside || inside.startsWith('..') || isAbsolute(inside) || temporaryIdentity.isSymbolicLink() || !temporaryIdentity.isDirectory())
      throw new Error('new test temporary directory escaped its checked parent');
    temporary.realPath = canonicalTemporary; temporary.device = String(temporaryIdentity.dev); temporary.inode = String(temporaryIdentity.ino);
    // 记录只属于这个 Job 的短路径；取消后由父侧空 Job 证明决定是否回收。
    await writeFile(resolve(logRoot, 'temporary.json'), `${JSON.stringify({ jobId, createdAt: startedAt, ...temporary }, null, 2)}\n`, { flag: 'wx' });
    signal?.throwIfAborted();
    phase = 'start'; startAttempted = true;
    scope = supervisor.provider.start({ command, args, ...(cwd ? { cwd } : {}), environment: { ...env, FORGE_CHECK_JOB_ID: jobId, FORGE_CHECK_JOB_TEMP: temporary.path },
      binding: randomUUID(), startupTimeoutMs: 10_000, terminationTimeoutMs: 10_000 },
    event => { writeSync(event.stream === 'stdout' ? stdout : stderr, event.chunk); });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    signal?.throwIfAborted();
    phase = 'root-pid'; rootPid = await scope.rootPid;
    phase = 'identity';
    const identity = await supervisor.reader.readIdentity({ pid: rootPid, signal: signal ? globalThis.AbortSignal.any([signal, globalThis.AbortSignal.timeout(10_000)]) : globalThis.AbortSignal.timeout(10_000) });
    if (identity.status !== 'FOUND') throw new Error('test supervisor identity is unavailable');
    signal?.throwIfAborted();
    phase = 'bind'; await scope.bind(identity.identity, signal);
    signal?.throwIfAborted();
    phase = 'authorize'; await scope.authorize(signal);
    phase = 'completion';
    completion = await scope.completion;
    signal?.throwIfAborted();
  } catch (error) { recordFailure(error); }
  finally {
    signal?.removeEventListener('abort', abort);
    await termination;
    phase = 'dispose';
    try { await scope?.dispose(); if (scope && !completion) completion = await scope.completion; } catch (error) { recordFailure(error); }
    phase = 'temporary-cleanup';
    if (temporary) {
      if (!startAttempted || completion?.closure?.empty === true) {
        try {
          await removeOwnedTemporary(temporary);
          temporary.status = 'removed';
        } catch (error) {
          temporary.status = 'retained'; temporary.reason = 'cleanup-failed'; temporary.error = failureDetails(error);
          recordFailure(error);
        }
      } else { temporary.status = 'retained'; temporary.reason = 'scope-closure-unconfirmed'; }
    }
    closeSync(stdout); closeSync(stderr);
  }
  let members;
  phase = 'diagnostics';
  try { members = await scope?.diagnostics?.(); } catch (error) { recordFailure(error); }
  // Job 的异步收尾已结束；终态发布不再让出事件循环，晚到取消先写成失败。
  if (signal?.aborted) recordFailure(signal.reason);
  const result = { name, startedAt, finishedAt: new Date().toISOString(), wallSeconds: (performance.now() - start) / 1000,
    jobId, rootPid, exitCode: completion?.exitCode ?? null, signal: completion?.signal ?? null, closure: completion?.closure ?? { status: 'unknown', reason: 'provider-failed' },
    ...(temporary ? { temporary } : {}),
    ...(members?.length && completion?.closure?.status !== 'closed' ? { members } : {}),
    ...(failed ? { error: { phase: failurePhase, ...failureDetails(failure) } } : {}) };
  if (result.closure.empty === true) recordTestWorkerEvent('scope-closed', { jobId, pid: rootPid, path: env.FORGE_CHECK_WORKER_EVENTS });
  writeFileSync(resolve(logRoot, 'process.json'), `${JSON.stringify(result, null, 2)}\n`);
  if (failed || result.exitCode !== 0 || result.signal !== null || result.closure.status !== 'closed' || result.closure.empty !== true) {
    const error = new Error(`${name} failed; see ${logRoot}`, { cause: failure }); error.result = result; throw error;
  }
  return result;
};
