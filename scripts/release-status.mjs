import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  createGitHubReleaseClient,
  filterReleaseLogs,
  readGitHubCredential,
} from './github-release.mjs';
import { parseReleaseArguments } from './release-arguments.mjs';
import { loadReleasePolicy } from './release-policy.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const argumentsValue = parseReleaseArguments(process.argv.slice(2));
if (argumentsValue.mode !== undefined || argumentsValue.packages.length > 0 || argumentsValue.retry) {
  throw new Error('release-status accepts only --sha and --logs');
}
const policy = await loadReleasePolicy(repositoryRoot);
const headSha = argumentsValue.sha ?? (() => {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0) throw new Error(result.stderr || 'unable to resolve HEAD');
  return result.stdout.trim();
})();
let client = createGitHubReleaseClient({ policy });
const run = (await client.listRuns()).find((candidate) => candidate.head_sha === headSha);
if (run === undefined) throw new Error(`no release workflow found for commit ${headSha}`);
const current = await client.getRun(run.id);
const jobs = await client.getJobs(run.id);
process.stdout.write(`${JSON.stringify({
  conclusion: current.conclusion,
  headSha: current.head_sha,
  htmlUrl: current.html_url,
  jobs: jobs.jobs.map(({ conclusion, name, status, steps }) => ({ conclusion, name, status, steps })),
  runNumber: current.run_number,
  status: current.status,
}, null, 2)}\n`);
if (argumentsValue.logs) {
  client = createGitHubReleaseClient({ policy, token: readGitHubCredential(repositoryRoot) });
  for (const job of jobs.jobs.filter(({ conclusion }) => conclusion !== 'success')) {
    const output = filterReleaseLogs(await client.getJobLogs(job.id));
    if (output !== '') process.stdout.write(`${output}\n`);
  }
}
if (current.status === 'completed' && current.conclusion !== 'success') process.exitCode = 1;
