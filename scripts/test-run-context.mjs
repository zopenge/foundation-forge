import { appendFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestWorkerBudget, testWorkerLimit } from './test-worker-budget.mjs';
import { discoverTestProcessSupervisor, runTestProcess } from './test-process-runner.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const capture = async path => {
  if ((await stat(path)).size > 16 * 1024 * 1024) throw new Error(`test output capture exceeded 16 MiB: ${path}`);
  return readFile(path, 'utf8');
};
export const createTestRunContext = async ({ packages, workers = testWorkerLimit() }) => {
  const parent = resolve(repositoryRoot, '.tmp/check-runs'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, 'run-'));
  const inheritedEvents = process.env.FORGE_CHECK_WORKER_EVENTS;
  const workerEvents = inheritedEvents ?? resolve(root, 'workers.jsonl');
  if (!inheritedEvents) await writeFile(workerEvents, '');
  const supervisor = await discoverTestProcessSupervisor({ packages });
  const budget = createTestWorkerBudget({ limit: workers, onEvent: event => {
    appendFileSync(resolve(root, 'budget.jsonl'), `${JSON.stringify(event)}\n`);
  } });
  let next = 0;
  const ownedJobs = new Set();
  const executeWithinSlot = async (spec, lease) => {
    const logRoot = spec.logRoot ?? resolve(root, 'jobs', String(next++));
    process.stdout.write(`test worker task: ${spec.name} (${lease.workers}/${budget.limit}); logs ${logRoot}\n`);
    const childWorkers = spec.nestedWorkerLimit ?? lease.workers;
    if (childWorkers < 1 || childWorkers > lease.workers) throw new Error('nested worker allocation exceeds its lease');
    let result;
    try { result = await runTestProcess({ ...spec, supervisor, logRoot, env: { ...(spec.env ?? process.env),
      FORGE_CHECK_TEST_WORKERS: String(childWorkers), VITEST_MAX_WORKERS: String(childWorkers),
      FORGE_CHECK_JOB_ROOT: logRoot, FORGE_CHECK_WORKER_EVENTS: workerEvents } });
    } catch (error) {
      if (error.result?.jobId) ownedJobs.add(error.result.jobId);
      const stdout = await capture(resolve(logRoot, 'stdout.log')), stderr = await capture(resolve(logRoot, 'stderr.log'));
      error.message += `\n${stdout}\n${stderr}`; throw error;
    }
    ownedJobs.add(result.jobId);
    const stdout = await capture(resolve(logRoot, 'stdout.log')), stderr = await capture(resolve(logRoot, 'stderr.log'));
    process.stdout.write(stdout); process.stderr.write(stderr);
    return { ...result, logRoot, stdout, stderr };
  };
  let executingWorkers = 0;
  const execute = async (spec, lease) => {
    testWorkerLimit(lease.workers);
    if (budget.summary().failed || executingWorkers + lease.workers > budget.limit) throw new Error('test worker allocation is stopped or already occupied');
    executingWorkers += lease.workers;
    try { return await executeWithinSlot(spec, lease); }
    finally { executingWorkers -= lease.workers; }
  };
  return { root, workerEvents, budget, execute,
    run: spec => budget.run({ name: spec.name, workers: spec.workers ?? 1 }, lease => execute(spec, lease)),
    finalize: async () => {
      const active = new Map(); let peak = 0;
      for (const line of (await readFile(workerEvents, 'utf8')).split(/\r?\n/u).filter(Boolean)) {
        const event = JSON.parse(line), key = `${event.jobId}:${event.pid}:${event.kind}`;
        if (event.type === 'start') active.set(key, event);
        if (event.type === 'finish') active.delete(key);
        if (event.type === 'scope-closed') for (const [id, value] of active) if (value.jobId === event.jobId) active.delete(id);
        peak = Math.max(peak, active.size);
      }
      const remainingWorkers = [...active.values()].filter(value => !inheritedEvents || ownedJobs.has(value.jobId));
      const summary = { ...budget.summary(), observedPeakWorkers: peak, remainingWorkers };
      await writeFile(resolve(root, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
      if (peak > 2 || remainingWorkers.length || summary.activeWorkers || executingWorkers) throw new Error(`test worker closure or two-worker ceiling failed; see ${root}`);
      return summary;
    },
  };
};
