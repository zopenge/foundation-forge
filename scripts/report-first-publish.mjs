import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { inspectTrustedPublishingReadiness } from './release-plan.mjs';
import { readPackageRegistryMetadata } from './release-registry.mjs';
import { loadReleasePolicy } from './release-policy.mjs';
import { discoverWorkspacePackageModel } from './workspace-packages.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const [policy, workspace] = await Promise.all([
  loadReleasePolicy(repositoryRoot),
  discoverWorkspacePackageModel({ repositoryRoot }),
]);
const states = await Promise.all(workspace.packages.map(async ({ name, version }) => {
  const metadata = await readPackageRegistryMetadata({ name, registry: policy.registry });
  return {
    name,
    version,
    versions: new Set(Object.keys(metadata?.versions ?? {})),
  };
}));
const readiness = inspectTrustedPublishingReadiness(states);

if (readiness.state === 'READY') {
  process.stdout.write('FIRST_PUBLISH_READY: every public package already exists in the canonical registry.\n');
} else {
  const packages = readiness.packages.map(({ bootstrapEligible, name, version }) => (
    `${name}@${version}${bootstrapEligible ? ' (bootstrap eligible)' : ' (bootstrap required before this version)'}`
  ));
  const message = `FIRST_PUBLISH_REQUIRED: ${packages.join(', ')}`;
  process.stdout.write(`${message}\n`);
  if (process.env.GITHUB_ACTIONS === 'true') {
    process.stdout.write(`::warning title=FIRST_PUBLISH_REQUIRED::${message}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `## FIRST_PUBLISH_REQUIRED\n\n${packages.map((value) => `- ${value}`).join('\n')}\n`,
      'utf8',
    );
  }
}
