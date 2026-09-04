import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';

import { redactKnownTokens } from './release-redaction.mjs';

export const selectWorkflowRun = (runs, { headSha, retry }) => {
  const run = runs.find((candidate) => candidate.head_sha === headSha);
  if (run === undefined) return { action: 'dispatch', previousRun: undefined };
  if (run.status !== 'completed') return { action: 'reuse', run };
  if (run.conclusion === 'success') return { action: 'verify', run };
  if (retry) return { action: 'dispatch', previousRun: run };
  throw new Error(`workflow run ${String(run.id)} ended with ${String(run.conclusion)}; use --retry to dispatch again`);
};

export const assertReleasePreflight = ({
  branch,
  configuredBranch,
  headSha,
  remoteSha,
  status,
}) => {
  if (status !== '') throw new Error('release requests require a clean working tree');
  if (branch !== configuredBranch) {
    throw new Error(`release requests must run from ${configuredBranch}`);
  }
  if (headSha !== remoteSha) throw new Error('release HEAD must be pushed to the configured remote branch');
};

export const filterReleaseLogs = (contents) => {
  const lines = stripVTControlCharacters(contents).split(/\r?\n/u);
  const selected = new Set();
  for (const [index, line] of lines.entries()) {
    if (/Publishing|published|npm error|ERR_|New tag|Existing tag/iu.test(line)) selected.add(index);
    if (/\bFAIL(?:\s|$)|\b\w*Error(?:\s+\[[^\]]+\])?:|::error\b|\berror\s+TS\d+|Unhandled Errors|ELIFECYCLE|Process completed with exit code [1-9]/iu.test(line)) {
      for (let cursor = index; cursor < Math.min(lines.length, index + 9); cursor += 1) {
        selected.add(cursor);
      }
    }
  }
  return lines.filter((_, index) => selected.has(index)).map(redactKnownTokens).join('\n');
};

const captureGit = (args, { cwd, input } = {}) => {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    input,
    shell: false,
    stdio: input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
};

export const readReleaseGitState = (repositoryRoot, configuredBranch) => {
  const branch = captureGit(['branch', '--show-current'], { cwd: repositoryRoot });
  const headSha = captureGit(['rev-parse', 'HEAD'], { cwd: repositoryRoot });
  const status = captureGit(['status', '--porcelain'], { cwd: repositoryRoot });
  const remoteOutput = captureGit([
    'ls-remote',
    'origin',
    `refs/heads/${configuredBranch}`,
  ], { cwd: repositoryRoot });
  const remoteSha = remoteOutput.split(/\s+/u)[0] ?? '';
  const state = { branch, configuredBranch, headSha, remoteSha, status };
  assertReleasePreflight(state);
  return state;
};

export const readGitHubCredential = (repositoryRoot) => {
  const output = captureGit(['credential', 'fill'], {
    cwd: repositoryRoot,
    input: 'protocol=https\nhost=github.com\n\n',
  });
  const values = Object.fromEntries(output.split(/\r?\n/u).map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  if (typeof values.password !== 'string' || values.password === '') {
    throw new Error('Git Credential Manager did not return a GitHub credential');
  }
  return values.password;
};

export const createGitHubReleaseClient = ({ fetch: fetchImplementation = globalThis.fetch, policy, token }) => {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'foundation-forge-release-tooling',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
  };
  const request = async (path, options = {}) => {
    const response = await fetchImplementation(`https://api.github.com/repos/${policy.githubRepository}${path}`, {
      ...options,
      headers: { ...headers, ...options.headers },
    });
    if (!response.ok && response.status !== 204) {
      throw new Error(`GitHub API ${path} returned ${String(response.status)}`);
    }
    return response;
  };
  return {
    dispatch: async () => {
      await request(`/actions/workflows/${policy.workflow}/dispatches`, {
        body: JSON.stringify({ ref: policy.branch }),
        method: 'POST',
      });
    },
    getJobLogs: async (jobId) => (await request(`/actions/jobs/${String(jobId)}/logs`)).text(),
    getJobs: async (runId) => (await request(`/actions/runs/${String(runId)}/jobs`)).json(),
    getRun: async (runId) => (await request(`/actions/runs/${String(runId)}`)).json(),
    listRuns: async ({ event } = {}) => (await request(
      `/actions/workflows/${policy.workflow}/runs?${event === undefined ? '' : `event=${event}&`}per_page=30`,
    )).json().then(({ workflow_runs: runs }) => runs),
  };
};

export const ensureWorkflowRun = async ({
  client,
  headSha,
  retry,
  timeoutMilliseconds = 60_000,
}) => {
  const decision = selectWorkflowRun(await client.listRuns({ event: 'workflow_dispatch' }), { headSha, retry });
  if (decision.action !== 'dispatch') return decision.run;
  await client.dispatch();
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() <= deadline) {
    const run = (await client.listRuns({ event: 'workflow_dispatch' }))
      .find((candidate) => candidate.head_sha === headSha);
    if (run !== undefined && run.id !== decision.previousRun?.id) return run;
    await delay(1_000);
  }
  throw new Error(`dispatched workflow did not appear for commit ${headSha}`);
};

export const waitForWorkflowRun = async ({ client, run, timeoutMilliseconds = 30 * 60_000 }) => {
  const deadline = Date.now() + timeoutMilliseconds;
  let current = run;
  while (current.status !== 'completed' && Date.now() <= deadline) {
    await delay(2_000);
    current = await client.getRun(current.id);
  }
  if (current.status !== 'completed') throw new Error(`workflow run ${String(current.id)} timed out`);
  if (current.conclusion !== 'success') {
    throw new Error(`workflow run ${String(current.id)} ended with ${String(current.conclusion)}`);
  }
  return current;
};
