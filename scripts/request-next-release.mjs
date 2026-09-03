import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createGitHubReleaseClient,
  ensureWorkflowRun,
  readGitHubCredential,
  readReleaseGitState,
  waitForWorkflowRun,
} from './github-release.mjs';
import { parseReleaseArguments } from './release-arguments.mjs';
import { assertNextReleasePlan, assertTrustedPublishingReady, createReleasePlan, hasPrereleaseVersion } from './release-plan.mjs';
import { loadReleasePolicy } from './release-policy.mjs';
import {
  readPackageRegistryMetadata,
  verifyRegistryPackages,
} from './release-registry.mjs';
import { discoverWorkspacePackageModel } from './workspace-packages.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const argumentsValue = parseReleaseArguments(process.argv.slice(2));
if (argumentsValue.logs || argumentsValue.mode !== undefined || argumentsValue.packages.length > 0 || argumentsValue.sha !== undefined) {
  throw new Error('request-next-release accepts only --retry');
}
const [policy, model] = await Promise.all([
  loadReleasePolicy(repositoryRoot),
  discoverWorkspacePackageModel({ repositoryRoot }),
]);
const state = readReleaseGitState(repositoryRoot, policy.branch);
const packageStates = await Promise.all(model.packages.map(async ({ name, version }) => {
  const metadata = await readPackageRegistryMetadata({ name, registry: policy.registry });
  return { name, version, versions: new Set(Object.keys(metadata?.versions ?? {})) };
}));
const plan = createReleasePlan(packageStates);
if (!hasPrereleaseVersion(plan)) throw new Error('at least one publishable package must use a prerelease version');
assertTrustedPublishingReady(packageStates);
assertNextReleasePlan(plan);
const targets = plan.filter(({ needsPublish }) => needsPublish).map(({ name }) => name);
if (targets.length > 0) {
  const client = createGitHubReleaseClient({
    policy,
    token: readGitHubCredential(repositoryRoot),
  });
  const run = await ensureWorkflowRun({
    client,
    headSha: state.headSha,
    retry: argumentsValue.retry,
  });
  await waitForWorkflowRun({ client, run });
} else {
  process.stdout.write('All local prerelease package versions are already published; skipping dispatch.\n');
}
await verifyRegistryPackages({
  expectedCommit: targets.length === 0 ? undefined : state.headSha,
  mode: 'next',
  model,
  packageNames: targets,
  policy,
  verificationRoot: resolve(repositoryRoot, '.tmp', 'registry-package-verification'),
});
