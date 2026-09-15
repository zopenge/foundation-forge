import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { inspectFirstPublishRegistry } from './first-publish-report.mjs';
import { readPackageRegistryMetadata } from './release-registry.mjs';
import { loadReleasePolicy } from './release-policy.mjs';
import { discoverWorkspacePackageModel } from './workspace-packages.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const [policy, workspace] = await Promise.all([
  loadReleasePolicy(repositoryRoot),
  discoverWorkspacePackageModel({ repositoryRoot }),
]);
const result = await inspectFirstPublishRegistry({
  packages: workspace.packages,
  readMetadata: (name) => readPackageRegistryMetadata({ name, registry: policy.registry }),
});

process.stdout.write(`${result.message}\n`);
if (result.state !== 'READY' && process.env.GITHUB_ACTIONS === 'true') {
  process.stdout.write(`::warning title=${result.state}::${result.message}\n`);
}
if (process.env.GITHUB_STEP_SUMMARY) {
  const details = result.packages.length === 0
    ? result.message
    : result.packages.map(({ bootstrapEligible, name, version }) => (
      `- ${name}@${version}${bootstrapEligible ? ' (bootstrap eligible)' : ''}`
    )).join('\n');
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `## ${result.state}\n\n${details}\n`,
    'utf8',
  );
}
