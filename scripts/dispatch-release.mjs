import { fileURLToPath } from 'node:url';

import {
  createGitHubReleaseClient,
  ensureWorkflowRun,
  readGitHubCredential,
  readReleaseGitState,
} from './github-release.mjs';
import { parseReleaseArguments } from './release-arguments.mjs';
import { loadReleasePolicy } from './release-policy.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const argumentsValue = parseReleaseArguments(process.argv.slice(2));
if (argumentsValue.logs || argumentsValue.mode !== undefined || argumentsValue.packages.length > 0 || argumentsValue.sha !== undefined) {
  throw new Error('dispatch-release accepts only --retry');
}
const policy = await loadReleasePolicy(repositoryRoot);
const state = readReleaseGitState(repositoryRoot, policy.branch);
const client = createGitHubReleaseClient({
  policy,
  token: readGitHubCredential(repositoryRoot),
});
const run = await ensureWorkflowRun({
  client,
  headSha: state.headSha,
  retry: argumentsValue.retry,
});
process.stdout.write(`Release workflow ${String(run.id)} is ${run.status}: ${run.html_url}\n`);
