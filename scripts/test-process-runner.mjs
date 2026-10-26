import { randomUUID } from 'node:crypto';
import { closeSync, openSync, writeSync } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { recordTestWorkerEvent } from './test-worker-events.mjs';

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
  const contained = relative(resolve(repositoryRoot, '.tmp'), resolve(logRoot));
  if (!contained || contained.startsWith('..') || isAbsolute(contained)) throw new Error('test logs must have an owned directory under .tmp');
  await mkdir(logRoot, { recursive: true });
  const stdout = openSync(resolve(logRoot, 'stdout.log'), 'w'), stderr = openSync(resolve(logRoot, 'stderr.log'), 'w');
  const startedAt = new Date().toISOString(), start = performance.now();
  const jobId = randomUUID();
  let scope, completion, failure, failurePhase, rootPid, failed = false, phase = 'start';
  const recordFailure = error => { if (!failed) { failed = true; failure = error; failurePhase = phase; } };
  const abort = () => { void scope?.terminate({ mode: 'force' }).catch(recordFailure); };
  try {
    scope = supervisor.provider.start({ command, args, ...(cwd ? { cwd } : {}), environment: { ...env, FORGE_CHECK_JOB_ID: jobId },
      binding: randomUUID(), startupTimeoutMs: 10_000, terminationTimeoutMs: 10_000 },
    event => { writeSync(event.stream === 'stdout' ? stdout : stderr, event.chunk); });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    phase = 'root-pid'; rootPid = await scope.rootPid;
    phase = 'identity';
    const identity = await supervisor.reader.readIdentity({ pid: rootPid, signal: globalThis.AbortSignal.timeout(10_000) });
    if (identity.status !== 'FOUND') throw new Error('test supervisor identity is unavailable');
    phase = 'bind'; await scope.bind(identity.identity, signal);
    phase = 'authorize'; await scope.authorize(signal);
    phase = 'completion';
    completion = await scope.completion;
  } catch (error) { recordFailure(error); }
  finally {
    signal?.removeEventListener('abort', abort);
    phase = 'dispose';
    try { await scope?.dispose(); if (scope && !completion) completion = await scope.completion; } catch (error) { recordFailure(error); }
    closeSync(stdout); closeSync(stderr);
  }
  const result = { name, startedAt, finishedAt: new Date().toISOString(), wallSeconds: (performance.now() - start) / 1000,
    jobId, rootPid, exitCode: completion?.exitCode ?? null, signal: completion?.signal ?? null, closure: completion?.closure ?? { status: 'unknown', reason: 'provider-failed' },
    ...(failed ? { error: { phase: failurePhase, ...failureDetails(failure) } } : {}) };
  if (result.closure.empty === true) recordTestWorkerEvent('scope-closed', { jobId, pid: rootPid, path: env.FORGE_CHECK_WORKER_EVENTS });
  await writeFile(resolve(logRoot, 'process.json'), `${JSON.stringify(result, null, 2)}\n`);
  if (failed || result.exitCode !== 0 || result.signal !== null || result.closure.status !== 'closed' || result.closure.empty !== true) {
    const error = new Error(`${name} failed; see ${logRoot}`, { cause: failure }); error.result = result; throw error;
  }
  return result;
};
