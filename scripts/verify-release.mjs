import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseReleaseArguments } from './release-arguments.mjs';
import { loadReleasePolicy } from './release-policy.mjs';
import { verifyRegistryPackages } from './release-registry.mjs';
import { discoverWorkspacePackageModel } from './workspace-packages.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const argumentsValue = parseReleaseArguments(process.argv.slice(2));
if (argumentsValue.logs || argumentsValue.retry) {
  throw new Error('verify-release does not accept --logs or --retry');
}
if (argumentsValue.mode === undefined) throw new Error('verify-release requires --mode');
const [policy, model] = await Promise.all([
  loadReleasePolicy(repositoryRoot),
  discoverWorkspacePackageModel({ repositoryRoot }),
]);
await verifyRegistryPackages({
  expectedCommit: argumentsValue.sha,
  mode: argumentsValue.mode,
  model,
  packageNames: argumentsValue.packages,
  policy,
  verificationRoot: resolve(repositoryRoot, '.tmp', 'registry-package-verification'),
});
