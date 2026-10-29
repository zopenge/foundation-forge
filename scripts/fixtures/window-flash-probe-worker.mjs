import { appendFileSync } from 'node:fs';
import { readReleaseTagCommit } from '../release-registry.mjs';
import { recordTestWorkerEvent } from '../test-worker-events.mjs';

const [cwd, trace] = process.argv.slice(2);
const stage = value => appendFileSync(trace, `${JSON.stringify({ ...value, pid: process.pid, jobId: process.env.FORGE_CHECK_JOB_ID,
  at: new Date().toISOString() })}\n`);
recordTestWorkerEvent('start', { kind: 'window-fixture' });
try {
  stage({ phase: 'git-query', callsite: 'release-registry/readReleaseTagCommit', npmExecPath: process.env.npm_execpath });
  const sha = readReleaseTagCommit({ mode: 'bootstrap', packageValue: { name: 'window-fixture', version: '0.0.0' }, repositoryRoot: cwd });
  stage({ phase: 'git-finished', sha });
} finally { recordTestWorkerEvent('finish', { kind: 'window-fixture' }); }
