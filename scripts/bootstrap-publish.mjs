import { fileURLToPath } from 'node:url';
import { runBootstrapRelease } from './release-bootstrap.mjs';
import { loadReleasePolicy } from './release-policy.mjs';
import { withReleaseLock } from './release-report.mjs';
import { redactKnownTokens } from './release-redaction.mjs';
import { discoverWorkspacePackageModel } from './workspace-packages.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const [policy, model] = await Promise.all([
  loadReleasePolicy(repositoryRoot),
  discoverWorkspacePackageModel({ repositoryRoot }),
]);
try {
  await withReleaseLock(repositoryRoot, () => runBootstrapRelease({ model, policy }));
} catch (error) {
  process.stderr.write(`${redactKnownTokens(error?.message ?? String(error))}\n`);
  process.exitCode = 1;
}
